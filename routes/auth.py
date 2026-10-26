"""
SurveyKart platform accounts: registration, sign-in, Kart points, and share redemption.

    GET  /signin                    sign in (Username/E-mail + Password, or Google)
    GET  /admin-login               SEPARATE Admin Login (platform owner only)
    POST /api/auth/admin-login      {identifier, password, next?} -> Admin Console
    GET  /register                  register a new SurveyKart account (+100 Kart points!)
    GET  /recover                   account lookup & recovery
    POST /api/auth/login            {identifier, password, next?, share_token?}
    POST /api/auth/register         {name, email, username?, password, share_token?}
    POST /api/auth/recover          {identifier} -> where that account stands
    POST /api/auth/recover/request  {identifier} -> one-time recovery link (e-mail, or the Admin desk queue)
    GET  /reset/<token>             set a new password from the link (also shows the username)
    POST /api/auth/reset            {token, password} -> new password
    GET  /share/<token>             redeem a shared project/respondent link (asks to register first)
    GET  /api/kart/catalog          dedicated question point catalog (public)
    GET  /api/kart/me               signed-in user's Kart balance, breakdown & shared links
    POST /api/kart/request-points   request Admin to allocate additional Kart points
    GET  /auth/google?mode=...      Google OAuth start (new & returning users alike)
    GET  /auth/google/callback      Google OAuth callback
    GET  /welcome                   friendly account-status page: a new Google
                                    account's "request sent to admin" screen,
                                    live-updating until approval adds 100 Kart pts
    POST /auth/dev                  DEV_LOGIN shortcut (never in production)
    POST /auth/logout               end the session
    GET  /api/me                    who is signed in (page chrome + Kart summary)
"""

from __future__ import annotations

import secrets
import time

from flask import (Blueprint, abort, current_app, g, jsonify, redirect,
                   render_template, request, session, url_for)

import core.accounts as accounts
import core.recovery as recovery
from core.google_auth import (GoogleAuthError, authorization_url, configured as google_configured,
                              exchange_and_verify)
from core.kart import (DEFAULT_INITIAL_POINTS, KART_CATALOG, QUESTION_POINTS,
                       create_point_request, get_share_by_token, redeem_share,
                       user_kart_summary, user_points_usage)
from core.security import audit, csrf_token
from models import StudyError, get_db

bp = Blueprint("auth", __name__)


@bp.app_template_global("account")
def account_global():
    """The signed-in platform profile (or None) - team chrome shows who is who."""
    user = current_user()
    if not user:
        return None
    return session_user_payload(user)


@bp.app_template_global("is_admin_actor")
def is_admin_actor_global() -> bool:
    """True when the current request is an Admin (platform admin or owner staff) or open local test."""
    if not current_app.config.get("STAFF_AUTH"):
        return True
    user = current_user()
    if user and user.get("role") == "admin" and user.get("status") == "approved":
        return True
    staff = getattr(g, "staff", None)
    if staff and staff.get("role") == "owner":
        return True
    return False


SAFE_NEXT = ("/welcome", "/workspace/", "/studio/", "/admin/", "/admin/console", "/admin-portal", "/survey/", "/")


def _safe_next(raw: str | None, fallback: str = "/workspace/") -> str:
    path = (raw or "").strip()
    if path and path.startswith(SAFE_NEXT) and not path.startswith("//"):
        return path
    return fallback


def _mode(raw) -> str:
    return "register" if str(raw or "") == "register" else "login"


def _redirect_uri() -> str:
    # Reverse proxies should supply X-Forwarded-Proto/Host (handled by ProxyFix), but
    # hosting panels sometimes omit one. An explicit URI avoids Google redirect_uri
    # mismatches in those deployments while preserving automatic local development.
    configured_uri = str(current_app.config.get("GOOGLE_REDIRECT_URI") or "").strip()
    return configured_uri or url_for("auth.google_callback", _external=True)


def _google_oauth_configured() -> bool:
    return google_configured(current_app.config.get("GOOGLE_CLIENT_ID", ""),
                             current_app.config.get("GOOGLE_CLIENT_SECRET", ""))


def current_user() -> dict | None:
    """The signed-in, still-existing platform profile for this request."""
    uid = session.get("uid")
    return accounts.by_id(uid) if uid else None


def masked_email(email: str) -> str:
    """Expose just a small clue to the account owner; full addresses stay in admin views."""
    value = str(email or "").strip()
    local, at, domain = value.partition("@")
    if not at or not local or not domain:
        return ""
    return local[:1] + "xxx@" + domain


def session_user_payload(user: dict) -> dict:
    used = user_points_usage(user["id"])
    limit = int(user.get("points_limit") if user.get("points_limit") is not None else DEFAULT_INITIAL_POINTS)
    is_admin = user["role"] == "admin"
    return {
        "id": user["id"],
        "email": user["email"],
        "email_masked": masked_email(user.get("email", "")),
        "username": user.get("username") or "",
        "name": user["name"],
        "picture": user["picture"],
        "role": user["role"],
        "status": user["status"],
        "auth_source": accounts.auth_source(user),
        "is_protected": bool(user.get("is_protected")),
        "points_limit": limit,
        "points_used": used,
        "points_balance": 999999 if is_admin else max(0, limit - used),
        "points_expiry": "No expiry; an admin may expire unused points at any time.",
        # 100 while a Google account waits for admin approval (the welcome
        # allocation lands in the Kart at the moment of approval), else 0.
        "welcome_points_pending": accounts.welcome_points_pending(user),
        "created_at": user.get("created_at") or "",
    }


def _share_redirect(redeemed: dict | None, default_next: str) -> str:
    if not redeemed:
        return default_next
    slug = redeemed.get("study_slug") or ""
    if redeemed.get("permission") == "respond" and slug:
        return f"/survey/{slug}"
    if slug:
        return f"/studio/#{slug}"
    return "/workspace/"


# --------------------------------------------------------------------- pages
@bp.get("/signin")
def signin_page():
    share_tok = request.args.get("share") or session.get("pending_share_token") or ""
    if request.args.get("share"):
        session["pending_share_token"] = share_tok
    share_info = get_share_by_token(share_tok) if share_tok else None
    return render_template(
        "auth_gate.html",
        mode="login",
        hint=request.args.get("email") or "",
        next_url=request.args.get("next") or "",
        share_token=share_tok if share_info else "",
        share_info=share_info,
    )


@bp.get("/register")
def register_page():
    share_tok = request.args.get("share") or session.get("pending_share_token") or ""
    if request.args.get("share"):
        session["pending_share_token"] = share_tok
    share_info = get_share_by_token(share_tok) if share_tok else None
    hint = request.args.get("email") or ((share_info or {}).get("shared_with_email") or "")
    return render_template(
        "auth_gate.html",
        mode="register",
        hint=hint,
        next_url=request.args.get("next") or "",
        share_token=share_tok if share_info else "",
        share_info=share_info,
    )


@bp.get("/recover")
def recover_page():
    return render_template("auth_gate.html", mode="recover", hint="", next_url="",
                           share_token="", share_info=None)


# --------------------------------------------------------------------- Share link gate
@bp.get("/share/<token>")
def open_share_link(token: str):
    """Open a shared project or respondent link.
    Asks new/signed-out users to register first; attaches the shared link to their
    account with 0 Kart points debited, then opens the shared workspace/studio/survey."""
    share = get_share_by_token(token)
    if not share:
        abort(404, "This shared SurveyKart link was not found or has been revoked.")
    user = current_user()
    if not user:
        session["pending_share_token"] = token
        q_email = ("&email=" + share["shared_with_email"]) if share.get("shared_with_email") else ""
        return redirect(f"/register?share={token}{q_email}")
    if user.get("status") != "approved":
        # Keep the link safe; it opens automatically once the admin approves.
        session["pending_share_token"] = token
        return redirect("/welcome")
    redeemed = redeem_share(token, user)
    g.user = user
    audit("share/redeem", study=share["study_slug"], detail=f"permission={share['permission']} (0 pts debited)")
    return redirect(_share_redirect(redeemed, "/studio/"))


# --------------------------------------------------------------------- sign-in throttling
def _login_attempt_row():
    address = request.remote_addr or "unknown"
    return address, get_db().execute(
        "SELECT * FROM login_attempts WHERE address=?", (address,)).fetchone()


def _login_throttled() -> bool:
    _address, attempt = _login_attempt_row()
    return bool(attempt and attempt["attempts"] >= 12 and time.time() - attempt["since"] < 900)


def _record_login_failure() -> None:
    address, attempt = _login_attempt_row()
    count = attempt["attempts"] + 1 if attempt and time.time() - attempt["since"] < 900 else 1
    since = attempt["since"] if count > 1 else time.time()
    with get_db() as db:
        db.execute("INSERT OR REPLACE INTO login_attempts VALUES(?,?,?)", (address, count, since))


def _clear_login_failures() -> None:
    with get_db() as db:
        db.execute("DELETE FROM login_attempts WHERE address=?",
                   (request.remote_addr or "unknown",))


# --------------------------------------------------------------------- Direct Credentials Auth
@bp.post("/api/auth/register")
def api_register():
    """Create an account (username + e-mail + password) → approval request to the admin.

    Same rule as Google sign-in: the account is ``pending`` with an empty Kart, the
    admin sees it in the approval queue, and approving it lands the one-time
    **100 Kart point** welcome allocation. The person is signed in just far enough
    to watch ``/welcome`` flip to approved (every team surface stays closed to a
    pending account — see ``core.security``). Addresses in ``ADMIN_EMAILS`` are the
    documented bootstrap and start approved with an unlimited Kart.
    """
    body = request.get_json(silent=True) or {}
    name = str(body.get("name") or "").strip()
    email = str(body.get("email") or "").strip()
    username = str(body.get("username") or "").strip()
    password = str(body.get("password") or "")
    share_tok = str(body.get("share_token") or session.get("pending_share_token") or "").strip()
    next_raw = str(body.get("next") or "")

    try:
        user = accounts.register_credentials(name=name, email=email, password=password, username=username)
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400

    session.clear()
    session["uid"] = user["id"]
    csrf_token()
    g.user = user
    audit("auth/register", detail=f"username + password ({user['status']})")

    if user["status"] != "approved":
        if share_tok:
            session["pending_share_token"] = share_tok
        next_path = _safe_next(next_raw, fallback="")
        if next_path and next_path != "/welcome":
            session["post_approval_next"] = next_path
        audit("auth/approval-request",
              detail=f"{user['email']} — awaiting admin approval "
                     f"(+{accounts.DEFAULT_POINTS} Kart pts on approval)")
        accounts.notify_admins_pending_signup(user)
        return jsonify({
            "ok": True,
            "pending": True,
            "status": user["status"],
            "user": session_user_payload(user),
            "welcome_points_pending": accounts.welcome_points_pending(user),
            "redirect": "/welcome",
        })

    redeemed = redeem_share(share_tok, user) if share_tok else None
    if redeemed:
        audit("share/redeem", study=redeemed.get("study_slug", ""), detail="0 pts debited")
    fallback = "/admin/console" if user["role"] == "admin" else "/studio/"
    dest = _share_redirect(redeemed, _safe_next(next_raw, fallback=fallback))
    return jsonify({
        "ok": True,
        "user": session_user_payload(user),
        "kart": user_kart_summary(user["id"]),
        "shared": redeemed,
        "redirect": dest,
    })


@bp.post("/api/auth/login")
def api_login():
    """Sign in with Username or E-mail + Password (including protected Admin ``Anaking.admin``)."""
    body = request.get_json(silent=True) or {}
    ident = str(body.get("identifier") or body.get("username") or body.get("email") or "").strip()
    password = str(body.get("password") or "")
    share_tok = str(body.get("share_token") or session.get("pending_share_token") or "").strip()
    next_raw = str(body.get("next") or "")

    if not ident or not password:
        return jsonify({"error": "Enter your username (or e-mail) and password."}), 400

    if _login_throttled():
        return jsonify({"error": "Too many sign-in attempts. Please wait 15 minutes and try again."}), 429

    user = accounts.authenticate_credentials(ident, password)
    if not user:
        _record_login_failure()
        return jsonify({"error": "Invalid username/e-mail or password."}), 401

    if user.get("status") != "approved":
        # Signed in far enough to watch /welcome: it explains the state and flips
        # to approved (with the 100 Kart points) the moment the admin grants access.
        msgs = {
            "pending": "Your account is waiting for admin approval — this page updates by itself.",
            "rejected": "This account was not approved by the platform admin.",
            "disabled": "This account has been disabled by the platform admin.",
        }
        session.clear()
        session["uid"] = user["id"]
        csrf_token()
        g.user = user
        return jsonify({
            "ok": True,
            "pending": True,
            "status": user.get("status"),
            "notice": msgs.get(user.get("status"), "Account is not active."),
            "user": session_user_payload(user),
            "redirect": "/welcome",
        })

    _clear_login_failures()

    session.clear()
    session["uid"] = user["id"]
    csrf_token()
    g.user = user
    audit("auth/signin", detail="admin" if user["role"] == "admin" else "user")

    redeemed = redeem_share(share_tok, user) if share_tok else None
    if redeemed:
        audit("share/redeem", study=redeemed.get("study_slug", ""), detail="0 pts debited")
    # Admins land where their work is (pending approvals, Kart points); users in Studio.
    fallback = "/admin/console" if user["role"] == "admin" else "/studio/"
    dest = _share_redirect(redeemed, _safe_next(next_raw, fallback=fallback))
    return jsonify({
        "ok": True,
        "user": session_user_payload(user),
        "kart": user_kart_summary(user["id"]),
        "shared": redeemed,
        "redirect": dest,
    })


@bp.get("/admin-login")
def admin_login_page():
    """Separate front door for the platform owner — kept apart from user sign-in.

    Already signed in as an admin? Straight to the console. Signed in as a
    regular user? The page says so, and signing in below simply switches
    account. The page also says plainly when ``ADMIN_PASSWORD`` isn't set up
    on this server, instead of letting the owner guess at passwords."""
    user = current_user()
    if user and user.get("role") == "admin" and user.get("status") == "approved":
        return redirect(_safe_next(request.args.get("next"), fallback="/admin/console"))
    return render_template(
        "admin_login.html",
        admin_username=accounts.MASTER_ADMIN_USERNAME,
        admin_password_configured=accounts.master_admin_password_configured(),
        signed_in_as=(user or {}).get("email") or "",
        next_url=request.args.get("next") or "",
    )


@bp.post("/api/auth/admin-login")
def api_admin_login():
    """Admin-only sign-in (the backend of /admin-login).

    Accepts the protected master admin (``Anaking.admin`` + ``ADMIN_PASSWORD``)
    or any approved admin account signing in with its own password — and lands
    in the Admin Console, where pending approval requests wait. Regular user
    credentials are refused with a clear pointer to the normal sign-in page."""
    body = request.get_json(silent=True) or {}
    ident = str(body.get("identifier") or body.get("username") or body.get("email") or "").strip()
    password = str(body.get("password") or "")
    next_raw = str(body.get("next") or "")

    if not ident or not password:
        return jsonify({"error": "Enter the admin username and password."}), 400
    if _login_throttled():
        return jsonify({"error": "Too many sign-in attempts. Please wait 15 minutes and try again."}), 429

    if (accounts.is_master_admin_identifier(ident)
            and not accounts.master_admin_password_configured()):
        return jsonify({
            "error": "Admin password sign-in isn't set up on this server yet. "
                     "Set ADMIN_PASSWORD in the server's .env / environment and restart "
                     "the app — or use “Sign in with Google” with an ADMIN_EMAILS account.",
            "code": "admin_password_unconfigured",
        }), 503

    user = accounts.authenticate_admin(ident, password)
    if not user:
        _record_login_failure()
        existing = accounts.by_email(ident) or accounts.by_username(ident)
        if accounts.is_master_admin_identifier(ident):
            msg = ("Incorrect admin password. It must match ADMIN_PASSWORD in the "
                   "server's .env / environment (restart the app after changing it).")
        elif existing and not existing.get("password_hash") and existing.get("google_sub"):
            msg = ("This account signs in with Google (it has no SurveyKart password) "
                   "— use “Sign in with Google” below.")
        elif existing and accounts.authenticate_credentials(ident, password):
            return jsonify({
                "error": "That account doesn't have admin rights. Use the regular "
                         "sign-in page — or the master admin username above.",
                "code": "not_admin",
            }), 403
        else:
            msg = "Invalid admin username or password."
        return jsonify({"error": msg}), 401

    _clear_login_failures()
    session.clear()
    session["uid"] = user["id"]
    csrf_token()
    g.user = user
    audit("auth/admin-signin", detail="separate admin login")
    return jsonify({
        "ok": True,
        "user": session_user_payload(user),
        "redirect": _safe_next(next_raw, fallback="/admin/console"),
    })


def _recover_ident(raw) -> tuple[str, str, dict | None]:
    """``(identifier, kind, user)`` — kind is ``email``, ``username`` or ``unknown``."""
    ident = str(raw or "").strip()
    if not ident:
        return "", "unknown", None
    if "@" in ident:
        return ident.lower(), "email", accounts.by_email(ident)
    return ident, "username", accounts.by_username(ident)


_STATUS_TEXT = {
    "approved": "This account is active. Sign in with your password"
                "{google} — or set a new password below.",
    "pending": "This account is registered and its approval request is with the platform "
               "admin. Once approved, 100 Kart points are added automatically.",
    "rejected": "This account was not approved by the platform admin. "
                "Contact the admin to ask for access.",
    "disabled": "This account is registered but currently disabled. "
                "Contact the platform admin to restore access.",
}


@bp.post("/api/auth/recover")
def recover_lookup():
    """Where an e-mail address *or username* stands (no secrets revealed)."""
    body = request.get_json(silent=True) or {}
    ident, kind, user = _recover_ident(body.get("identifier") or body.get("email")
                                       or body.get("username"))
    if not ident:
        return jsonify({"error": "Enter your e-mail address or your SurveyKart username."}), 400
    if not user:
        return jsonify({
            "found": False, "kind": kind,
            "message": f"No account uses that {kind}. If you are new, register — "
                       f"100 Kart points land the moment the admin approves you.",
        })
    state = accounts.signin_identity(user)
    return jsonify({
        "found": True,
        "status": user["status"],
        "kind": kind,
        "signs_in_with_google": state["google"],
        "has_password": state["has_password"],
        "message": _STATUS_TEXT.get(user["status"], "This account is not active.").format(
            google=" or Google" if state["google"] else ""),
    })


@bp.post("/api/auth/recover/request")
def recover_request():
    """Issue a one-time recovery link: e-mailed automatically, or queued for the admin.

    The response never contains the link — whoever typed the address must already
    control the mailbox (or the admin hands it over), so knowing an e-mail address
    is never enough to take an account over.
    """
    body = request.get_json(silent=True) or {}
    ident, kind, user = _recover_ident(body.get("identifier") or body.get("email")
                                       or body.get("username"))
    if not ident:
        return jsonify({"error": "Enter your e-mail address or your SurveyKart username."}), 400
    if _login_throttled():
        return jsonify({"error": "Too many attempts. Please wait 15 minutes and try again."}), 429

    generic = ("If that account exists, a one-time recovery link has been created. "
               "It lets you set a new password and shows your username.")
    if not user:
        _record_login_failure()
        return jsonify({"ok": True, "sent": False, "message": generic})

    if user["role"] == "admin" and accounts.is_protected_admin(user):
        return jsonify({
            "ok": True, "sent": False, "status": user["status"],
            "message": "The master admin signs in with ADMIN_PASSWORD — ask the server owner "
                       "to change it in .env and restart the app.",
        })

    issued = recovery.issue(user, requested_by="self-service",
                            requested_ip=request.remote_addr or "",
                            note=f"requested from /recover ({kind})")
    audit("auth/recover-request",
          detail=f"{user['email']} — link {issued['delivered']}")
    if issued["delivered"] == "email":
        message = ("Check your inbox — the recovery link is on its way and works once, "
                   "for 60 minutes.")
    else:
        message = ("This server has no mail configured yet, so your request is now with the "
                   "SurveyKart admin (Anaking.admin). They will send you the link — sign in "
                   "again after that.")
    return jsonify({
        "ok": True, "sent": True, "delivery": issued["delivered"],
        "status": user["status"], "has_password": accounts.has_password(user),
        "signs_in_with_google": accounts.signin_identity(user)["google"],
        "message": message,
    })


@bp.get("/reset/<token>")
def reset_page(token: str):
    """The link itself: shows the username and takes a new password."""
    reset = recovery.by_token(token)
    if not reset or not reset.get("usable"):
        reason = ("This recovery link has already been used." if reset and reset.get("used_at")
                  else "This recovery link has expired or was replaced by a newer one.")
        return render_template("reset_password.html", valid=False, reason=reason,
                               token="", user=None, email=""), 410
    user = reset["user"]
    return render_template("reset_password.html", valid=True, reason="", token=token,
                           user=accounts.signin_identity(user), email=user["email"],
                           name=user.get("name") or "", expires_at=reset["expires_at"])


@bp.post("/api/auth/reset")
def api_reset():
    """Set a new password from a valid one-time link, then sign in."""
    body = request.get_json(silent=True) or {}
    token = str(body.get("token") or "")
    password = str(body.get("password") or "")
    confirm = str(body.get("confirm") if body.get("confirm") is not None else password)
    if password != confirm:
        return jsonify({"error": "The two passwords do not match."}), 400
    try:
        user = recovery.consume(token, password)
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400
    session.clear()
    session["uid"] = user["id"]
    csrf_token()
    g.user = user
    audit("auth/password-reset", detail=f"{user['email']} set a new password from a recovery link")
    dest = "/welcome" if user["status"] != "approved" else (
        "/admin/console" if user["role"] == "admin" else "/studio/")
    return jsonify({"ok": True, "user": session_user_payload(user), "redirect": dest})


# --------------------------------------------------------------------- Kart APIs
@bp.get("/api/kart/catalog")
def kart_catalog():
    return jsonify({
        "default_points": DEFAULT_INITIAL_POINTS,
        "question_points": QUESTION_POINTS,
        "catalog": KART_CATALOG,
    })


@bp.get("/api/kart/me")
def kart_me():
    user = current_user()
    if not user:
        return jsonify({
            "ok": True,
            "kart": {
                "authenticated": False,
                "is_admin": not current_app.config.get("STAFF_AUTH"),
                "points_limit": DEFAULT_INITIAL_POINTS,
                "points_used": 0,
                "points_balance": DEFAULT_INITIAL_POINTS,
                "owned_projects": [],
                "shared_projects": [],
                "requests": [],
                "transactions": [],
            },
            "question_points": QUESTION_POINTS,
            "catalog": KART_CATALOG,
        })
    return jsonify({
        "ok": True,
        "kart": user_kart_summary(user["id"]),
        "question_points": QUESTION_POINTS,
        "catalog": KART_CATALOG,
    })


@bp.post("/api/kart/request-points")
def kart_request_points():
    user = current_user()
    if not user:
        return jsonify({"error": "Sign-in required to request Kart points."}), 401
    body = request.get_json(silent=True) or {}
    try:
        req = create_point_request(
            user_id=user["id"],
            requested_points=int(body.get("requested_points") or 50),
            reason=str(body.get("reason") or ""),
        )
    except (StudyError, ValueError, TypeError) as exc:
        msg = exc.message if isinstance(exc, StudyError) else str(exc)
        return jsonify({"error": msg}), 400
    audit("kart/request-points", detail=f"+{req['requested_points']} pts requested")
    return jsonify({"ok": True, "request": req, "kart": user_kart_summary(user["id"])})


# --------------------------------------------------------------------- Google flow
@bp.get("/auth/google")
def google_login():
    """One Google entry point for everyone.  ``mode`` (login|register) is kept
    for link compatibility, but both behave the same friendly way: a returning
    account signs straight in, while a brand-new Google account is created and
    sent to the admin as an approval request (100 Kart pts land on approval)."""
    mode = _mode(request.args.get("mode"))
    if request.args.get("share"):
        session["pending_share_token"] = request.args.get("share")
    if not _google_oauth_configured():
        dest = "/register" if mode == "register" else "/signin"
        share = session.get("pending_share_token") or ""
        if share:
            dest += "?share=" + share + "&notice=google-off"
        else:
            dest += "?notice=google-off"
        nxt = (request.args.get("next") or "").strip()
        if nxt:
            dest += "&next=" + nxt
        return redirect(dest)
    state = secrets.token_urlsafe(24)
    session["oauth_state"] = state
    session["oauth_mode"] = mode
    session["oauth_next"] = _safe_next(request.args.get("next"))
    return redirect(authorization_url(current_app.config["GOOGLE_CLIENT_ID"],
                                      _redirect_uri(), state))


@bp.get("/auth/google/callback")
def google_callback():
    mode = _mode(session.pop("oauth_mode", "login"))
    if request.args.get("error"):
        return render_template("auth_error.html",
                               message="Google sign-in was cancelled or refused."), 401
    if not secrets.compare_digest(request.args.get("state", ""), session.get("oauth_state", "!")):
        return render_template("auth_error.html",
                               message="This sign-in link has expired. Go back and try again."), 403
    session.pop("oauth_state", None)
    try:
        claims = exchange_and_verify(
            request.args.get("code", ""), _redirect_uri(),
            current_app.config["GOOGLE_CLIENT_ID"],
            current_app.config["GOOGLE_CLIENT_SECRET"])
    except GoogleAuthError as exc:
        return render_template("auth_error.html", message=str(exc)), 401
    return _complete(claims, mode)


def _complete(claims: dict, mode: str):
    """Shared landing logic for the Google callback and the dev shortcut.

    Easy-for-everyone rule: whatever button the person clicked, an unknown
    Google e-mail simply *becomes* a new account.  New regular accounts are
    ``pending`` — an approval request for the admin (audit trail + optional
    e-mail to ADMIN_EMAILS) — and the person lands on /welcome, a live status
    page promising the 100 Kart pts that are added the moment the admin
    approves.  Approved accounts continue straight to where they were going.
    """
    email = str(claims.get("email") or "").strip().lower()
    existing = accounts.by_email(email)
    fresh = existing is None
    user = accounts.upsert_from_claims(claims)
    next_path = _safe_next(session.pop("oauth_next", None))
    share_tok = session.pop("pending_share_token", "")
    session.clear()
    session["uid"] = user["id"]
    csrf_token()
    g.user = user
    audit("auth/register" if fresh else "auth/signin")
    if user["status"] != "approved":
        # Preserve where the person was heading (and any shared link) so the
        # /welcome page can continue them there right after approval.
        if share_tok:
            session["pending_share_token"] = share_tok
        if next_path and next_path != "/welcome":
            session["post_approval_next"] = next_path
        if fresh and user["status"] == "pending":
            audit("auth/approval-request",
                  detail=f"{email} via Google — awaiting admin approval "
                         f"(+{accounts.DEFAULT_POINTS} Kart pts on approval)")
            accounts.notify_admins_pending_signup(user)
        return redirect("/welcome")
    redeemed = redeem_share(share_tok, user) if share_tok else None
    if redeemed:
        audit("share/redeem", study=redeemed.get("study_slug", ""), detail="0 pts debited")
    return redirect(_share_redirect(redeemed, next_path))


@bp.get("/welcome")
def welcome_page():
    """One friendly home for every account state after Google sign-in.

    pending  → "request sent to admin" with the 100-pt promise; the page
               polls /api/me and flips to the approved celebration by itself.
    approved → "you're in" + live Kart balance + continue button (a shared
               link saved while pending is redeemed and opened from here).
    rejected / disabled → a clear explanation and how to get help.
    """
    user = current_user()
    if not user:
        return redirect("/signin?next=" + "/welcome")
    g.user = user
    next_path = _safe_next(session.get("post_approval_next") or request.args.get("next"))
    if user["status"] == "approved":
        session.pop("post_approval_next", None)
    redeemed = None
    share_tok = session.get("pending_share_token") or ""
    if user["status"] == "approved" and share_tok:
        session.pop("pending_share_token", None)
        redeemed = redeem_share(share_tok, user)
        if redeemed:
            audit("share/redeem", study=redeemed.get("study_slug", ""), detail="0 pts debited")
            next_path = _share_redirect(redeemed, next_path)
    return render_template(
        "account_status.html",
        user=session_user_payload(user),
        profile=user,
        kart=user_kart_summary(user["id"]),
        next_url=next_path,
        has_share=bool(share_tok and user["status"] != "approved") or bool(redeemed),
        redeemed=redeemed,
    )


@bp.post("/auth/dev")
def dev_login():
    """Development-only e-mail sign-in (DEV_LOGIN=1, never in production).

    Mirrors the Google flow exactly: a new e-mail becomes a pending account
    (an approval request for the admin, 100 Kart pts on approval) whichever
    ``mode`` was used; an approved account signs straight in."""
    if not current_app.config.get("DEV_LOGIN"):
        abort(404)
    body = request.get_json(silent=True) or {}
    claims = {"email": str(body.get("email") or "").strip().lower(),
              "name": body.get("name") or "", "sub": "dev:" + str(body.get("email") or "")}
    mode = _mode(body.get("mode"))
    if not claims["email"] or "@" not in claims["email"]:
        return jsonify({"error": "Use a real e-mail address."}), 400
    fresh = accounts.by_email(claims["email"]) is None
    role = str(body.get("role") or "")
    if role == "admin" and mode == "register":
        user = accounts.create_dev_user(claims["email"], claims["name"], role="admin")
    else:
        user = accounts.upsert_from_claims(claims)
    share_tok = session.pop("pending_share_token", "")
    session.clear()
    session["uid"] = user["id"]
    csrf_token()
    g.user = user
    audit("auth/register" if fresh else "auth/signin")
    redeemed = None
    if share_tok:
        if user["status"] == "approved":
            redeemed = redeem_share(share_tok, user)
        else:
            session["pending_share_token"] = share_tok
    dest = "/welcome" if user["status"] != "approved" else _share_redirect(redeemed, "/workspace/")
    return jsonify({"ok": True, "user": session_user_payload(user), "redirect": dest})


@bp.post("/auth/logout")
def logout():
    session.clear()
    if request.headers.get("X-Requested-With") or request.is_json:
        return jsonify({"ok": True})
    return redirect("/")


@bp.get("/api/me")
def me():
    user = current_user()
    return jsonify({
        "user": session_user_payload(user) if user else None,
        "google_configured": _google_oauth_configured(),
        "dev_login": bool(current_app.config.get("DEV_LOGIN")),
        "staff_auth": bool(current_app.config.get("STAFF_AUTH")),
    })
