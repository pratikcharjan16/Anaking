"""
SurveyKart platform accounts: registration, sign-in, Kart points, and share redemption.

    GET  /signin                    sign in (Username/E-mail + Password, or Google)
    GET  /register                  register a new SurveyKart account (+100 Kart points!)
    GET  /recover                   account lookup & recovery
    POST /api/auth/login            {identifier, password, next?, share_token?}
    POST /api/auth/register         {name, email, username?, password, share_token?}
    POST /api/auth/recover          {email} -> where that address stands
    GET  /share/<token>             redeem a shared project/respondent link (asks to register first)
    GET  /api/kart/catalog          dedicated question point catalog (public)
    GET  /api/kart/me               signed-in user's Kart balance, breakdown & shared links
    POST /api/kart/request-points   request Admin to allocate additional Kart points
    GET  /auth/google?mode=...      Google OAuth start
    GET  /auth/google/callback      Google OAuth callback
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
from core.google_auth import GoogleAuthError, authorization_url, exchange_and_verify
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


SAFE_NEXT = ("/workspace/", "/studio/", "/admin/", "/admin/console", "/admin-portal", "/survey/", "/")


def _safe_next(raw: str | None, fallback: str = "/workspace/") -> str:
    path = (raw or "").strip()
    if path and path.startswith(SAFE_NEXT) and not path.startswith("//"):
        return path
    return fallback


def _mode(raw) -> str:
    return "register" if str(raw or "") == "register" else "login"


def _redirect_uri() -> str:
    return url_for("auth.google_callback", _external=True)


def current_user() -> dict | None:
    """The signed-in, still-existing platform profile for this request."""
    uid = session.get("uid")
    return accounts.by_id(uid) if uid else None


def session_user_payload(user: dict) -> dict:
    used = user_points_usage(user["id"])
    limit = int(user.get("points_limit") if user.get("points_limit") is not None else DEFAULT_INITIAL_POINTS)
    is_admin = user["role"] == "admin"
    return {
        "id": user["id"],
        "email": user["email"],
        "username": user.get("username") or "",
        "name": user["name"],
        "picture": user["picture"],
        "role": user["role"],
        "status": user["status"],
        "is_protected": bool(user.get("is_protected")),
        "points_limit": limit,
        "points_used": used,
        "points_balance": 999999 if is_admin else max(0, limit - used),
    }


def _share_redirect(redeemed: dict | None, default_next: str) -> str:
    if not redeemed:
        return default_next
    slug = redeemed.get("study_slug") or ""
    if redeemed.get("permission") == "respond":
        return f"/survey/{slug}"
    return f"/studio/#{slug}"


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
        hint=request.args.get("unknown") or request.args.get("email") or "",
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
        return redirect("/?welcome=1")
    redeemed = redeem_share(token, user)
    g.user = user
    audit("share/redeem", study=share["study_slug"], detail=f"permission={share['permission']} (0 pts debited)")
    return redirect(_share_redirect(redeemed, "/studio/"))


# --------------------------------------------------------------------- Direct Credentials Auth
@bp.post("/api/auth/register")
def api_register():
    """Register a new user on SurveyKart and allocate 100 initial Kart points."""
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
    audit("auth/register", detail="100 Kart points allocated")

    redeemed = redeem_share(share_tok, user) if share_tok else None
    if redeemed:
        audit("share/redeem", study=redeemed.get("study_slug", ""), detail="0 pts debited")
    dest = _share_redirect(redeemed, _safe_next(next_raw, fallback="/studio/"))
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

    address = request.remote_addr or "unknown"
    db = get_db()
    attempt = db.execute("SELECT * FROM login_attempts WHERE address=?", (address,)).fetchone()
    if attempt and attempt["attempts"] >= 12 and time.time() - attempt["since"] < 900:
        return jsonify({"error": "Too many sign-in attempts. Please wait 15 minutes and try again."}), 429

    user = accounts.authenticate_credentials(ident, password)
    if not user:
        count = attempt["attempts"] + 1 if attempt and time.time() - attempt["since"] < 900 else 1
        since = attempt["since"] if count > 1 else time.time()
        with db:
            db.execute("INSERT OR REPLACE INTO login_attempts VALUES(?,?,?)", (address, count, since))
        return jsonify({"error": "Invalid username/e-mail or password."}), 401

    if user.get("status") != "approved":
        msgs = {
            "pending": "Your account is waiting for admin approval.",
            "rejected": "This account was not approved by the platform admin.",
            "disabled": "This account has been disabled by the platform admin.",
        }
        return jsonify({"error": msgs.get(user.get("status"), "Account is not active.")}), 403

    with db:
        db.execute("DELETE FROM login_attempts WHERE address=?", (address,))

    session.clear()
    session["uid"] = user["id"]
    csrf_token()
    g.user = user
    audit("auth/signin", detail="admin" if user["role"] == "admin" else "user")

    redeemed = redeem_share(share_tok, user) if share_tok else None
    if redeemed:
        audit("share/redeem", study=redeemed.get("study_slug", ""), detail="0 pts debited")
    fallback = "/studio/" if user["role"] == "admin" else "/studio/"
    dest = _share_redirect(redeemed, _safe_next(next_raw, fallback=fallback))
    return jsonify({
        "ok": True,
        "user": session_user_payload(user),
        "kart": user_kart_summary(user["id"]),
        "shared": redeemed,
        "redirect": dest,
    })


@bp.post("/api/auth/recover")
def recover_lookup():
    """Where an e-mail or username stands."""
    body = request.get_json(silent=True) or {}
    email = str(body.get("email") or "").strip().lower()
    if "@" not in email:
        return jsonify({"error": "Enter the e-mail address you registered with."}), 400
    user = accounts.by_email(email)
    if not user:
        return jsonify({"found": False,
                        "message": "No account uses this address yet. "
                                   "If you are new, register on SurveyKart to receive 100 Kart points."})
    status_text = {
        "approved": "This address has an active SurveyKart account. Sign in with your password or Google.",
        "pending": "This address is registered and waiting for the platform admin's approval.",
        "rejected": "This address was not approved by the platform admin. "
                    "Contact the admin to ask for access.",
        "disabled": "This address is registered but currently disabled. "
                    "Contact the platform admin to restore access.",
    }
    return jsonify({"found": True, "status": user["status"], "message": status_text.get(user["status"], "")})


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
    mode = _mode(request.args.get("mode"))
    if request.args.get("share"):
        session["pending_share_token"] = request.args.get("share")
    if not current_app.config.get("GOOGLE_CLIENT_ID"):
        return render_template("auth_error.html",
                               message="Google sign-in is not configured on this server yet. "
                                       "Use SurveyKart username/e-mail & password sign-in, or ask "
                                       "the admin to set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET."), 503
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
    """Shared landing logic for the Google callback and the dev shortcut."""
    email = str(claims.get("email") or "").strip().lower()
    existing = accounts.by_email(email)
    if existing is None and mode == "login" and not accounts.is_admin_email(email):
        return redirect("/signin?unknown=1&email=" + email)
    fresh = existing is None
    user = accounts.upsert_from_claims(claims)
    next_path = _safe_next(session.pop("oauth_next", None))
    share_tok = session.pop("pending_share_token", "")
    session.clear()
    session["uid"] = user["id"]
    csrf_token()
    g.user = user
    audit("auth/register" if fresh else "auth/signin")
    redeemed = redeem_share(share_tok, user) if (share_tok and user["status"] == "approved") else None
    if user["status"] == "pending":
        if share_tok:
            session["pending_share_token"] = share_tok
        return redirect("/?welcome=1")
    return redirect(_share_redirect(redeemed, next_path))


@bp.post("/auth/dev")
def dev_login():
    """Development-only e-mail sign-in (DEV_LOGIN=1, never in production)."""
    if not current_app.config.get("DEV_LOGIN"):
        abort(404)
    body = request.get_json(silent=True) or {}
    claims = {"email": str(body.get("email") or "").strip().lower(),
              "name": body.get("name") or "", "sub": "dev:" + str(body.get("email") or "")}
    mode = _mode(body.get("mode"))
    if not claims["email"] or "@" not in claims["email"]:
        return jsonify({"error": "Use a real e-mail address."}), 400
    existing = accounts.by_email(claims["email"])
    if existing is None and mode == "login" and not accounts.is_admin_email(claims["email"]):
        return jsonify({"error": "No account for this e-mail yet - register first.",
                        "need_register": True, "email": claims["email"]}), 404
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
    audit("auth/signin")
    if share_tok and user["status"] == "approved":
        redeem_share(share_tok, user)
    return jsonify({"ok": True, "user": session_user_payload(user)})


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
        "google_configured": bool(current_app.config.get("GOOGLE_CLIENT_ID")),
        "dev_login": bool(current_app.config.get("DEV_LOGIN")),
        "staff_auth": bool(current_app.config.get("STAFF_AUTH")),
    })
