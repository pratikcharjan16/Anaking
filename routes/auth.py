"""
Platform accounts: registration, sign-in and recovery - all through Google.

    GET  /signin                  existing users: sign in with Google
    GET  /register                new users: create your account with Google
    GET  /recover                 forgot your user ID or password?
    POST /api/auth/recover        {email} -> where that address stands
    GET  /auth/google?mode=...    start the Google round trip (login | register)
    GET  /auth/google/callback    finish it
    POST /auth/dev                DEV_LOGIN shortcut (never in production)
    POST /auth/logout             end the session
    GET  /api/me                  who is signed in (page chrome)

Registration and sign-in are one Google round trip but different promises:

- **register** creates the profile (one per e-mail) as *pending*; an admin then
  approves it in the console at /admin/console.  Already registered? Registration
  simply signs you in.
- **login** never silently creates anything - a Google e-mail without a profile
  is sent back to registration (with the address filled in), except the
  ``ADMIN_EMAILS`` bootstrap so the console can never be locked out.

There is no separate platform password: your user ID is your Google e-mail and
the password is your Google password, which Google recovers (the /recover page
says exactly that and offers account lookup + the admin contact).

Respondent survey links never come through here - fieldwork is always public.
"""

from __future__ import annotations

import secrets

from flask import (Blueprint, abort, current_app, jsonify, redirect,
                   render_template, request, session, url_for)

import core.accounts as accounts
from core.google_auth import GoogleAuthError, authorization_url, exchange_and_verify

bp = Blueprint("auth", __name__)


@bp.app_template_global("account")
def account_global():
    """The signed-in platform profile (or None) - team chrome shows who is who."""
    user = current_user()
    return {"email": user["email"], "name": user["name"], "picture": user["picture"],
            "role": user["role"], "status": user["status"]} if user else None


SAFE_NEXT = ("/workspace/", "/studio/", "/admin/", "/admin/console", "/")


def _safe_next(raw: str | None) -> str:
    path = raw or ""
    if path.startswith(SAFE_NEXT) and not path.startswith("//"):
        return path
    return "/workspace/"


def _mode(raw) -> str:
    return "register" if str(raw or "") == "register" else "login"


def _redirect_uri() -> str:
    return url_for("auth.google_callback", _external=True)


def current_user() -> dict | None:
    """The signed-in, still-existing platform profile for this request."""
    uid = session.get("uid")
    return accounts.by_id(uid) if uid else None


def session_user_payload(user: dict) -> dict:
    return {"id": user["id"], "email": user["email"], "name": user["name"],
            "picture": user["picture"], "role": user["role"], "status": user["status"]}


# --------------------------------------------------------------------- pages
@bp.get("/signin")
def signin_page():
    return render_template("auth_gate.html", mode="login",
                           hint=request.args.get("unknown") or request.args.get("email") or "")


@bp.get("/register")
def register_page():
    return render_template("auth_gate.html", mode="register",
                           hint=request.args.get("email") or "")


@bp.get("/recover")
def recover_page():
    return render_template("auth_gate.html", mode="recover", hint="")


@bp.post("/api/auth/recover")
def recover_lookup():
    """Where an e-mail address stands - the 'forgot user ID' lookup.

    A user's ID *is* their Google e-mail, so the common case is simply forgetting
    which address was used.  Reply is deliberately plain about status; on a
    platform where the admin approves everyone by e-mail anyway, this reveals
    nothing the requester can act on.
    """
    body = request.get_json(silent=True) or {}
    email = str(body.get("email") or "").strip().lower()
    if "@" not in email:
        return jsonify({"error": "Enter the e-mail address you used with Google."}), 400
    user = accounts.by_email(email)
    if not user:
        return jsonify({"found": False,
                        "message": "No account uses this address yet. "
                                   "If you are new, register first - it takes one click with Google."})
    status_text = {
        "approved": "This address has an approved account. Sign in with Google - "
                    "your user ID is this e-mail and your password is your Google password.",
        "pending": "This address is registered and waiting for the platform admin's approval.",
        "rejected": "This address was not approved by the platform admin. "
                    "Contact the admin to ask for access.",
        "disabled": "This address is registered but currently disabled. "
                    "Contact the platform admin to restore access.",
    }
    return jsonify({"found": True, "status": user["status"], "message": status_text.get(user["status"], "")})


# --------------------------------------------------------------------- Google flow
@bp.get("/auth/google")
def google_login():
    mode = _mode(request.args.get("mode"))
    if not current_app.config.get("GOOGLE_CLIENT_ID"):
        return render_template("auth_error.html",
                               message="Google sign-in is not configured on this server yet. "
                                       "Ask the admin to set GOOGLE_CLIENT_ID and "
                                       "GOOGLE_CLIENT_SECRET."), 503
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
        # signing in must never silently register someone
        return redirect("/signin?unknown=1&email=" + email)
    fresh = accounts.by_email(str(claims.get("email") or "").strip().lower()) is None
    user = accounts.upsert_from_claims(claims)
    next_path = _safe_next(session.pop("oauth_next", None))
    session.clear()                              # session fixation: full reset on sign-in
    session["uid"] = user["id"]
    from flask import g
    g.user = user                                # so the audit line carries the right actor
    from core.security import audit
    audit("auth/register" if fresh else "auth/signin")
    if user["status"] == "pending":
        return redirect("/?welcome=1")
    return redirect(next_path)


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
    session.clear()
    session["uid"] = user["id"]
    from flask import g
    g.user = user
    from core.security import audit
    audit("auth/signin")
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
    })
