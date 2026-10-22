"""
Platform sign-in: Google accounts -> approved profile -> workspace.

    GET  /auth/google            start the Google round trip
    GET  /auth/google/callback   finish it; upsert the profile; set the session
    POST /auth/dev               DEV_LOGIN shortcut (never in production)
    POST /auth/logout            end the session
    GET  /api/me                 who is signed in (used by every page chrome)

The first sign-in lands as *pending*; an admin approves people in the console at
/admin/console.  Approved users go straight to their projects; pending users see
the "waiting for approval" notice on the landing page.  Respondent survey links
never come through here - fieldwork is always public.
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


def _redirect_uri() -> str:
    return url_for("auth.google_callback", _external=True)


def current_user() -> dict | None:
    """The signed-in, still-existing platform profile for this request."""
    uid = session.get("uid")
    return accounts.by_id(uid) if uid else None


def session_user_payload(user: dict) -> dict:
    return {"id": user["id"], "email": user["email"], "name": user["name"],
            "picture": user["picture"], "role": user["role"], "status": user["status"]}


@bp.get("/auth/google")
def google_login():
    if not current_app.config.get("GOOGLE_CLIENT_ID"):
        return render_template("auth_error.html",
                               message="Google sign-in is not configured on this server yet. "
                                       "Ask the admin to set GOOGLE_CLIENT_ID and "
                                       "GOOGLE_CLIENT_SECRET."), 503
    state = secrets.token_urlsafe(24)
    session["oauth_state"] = state
    session["oauth_next"] = _safe_next(request.args.get("next"))
    return redirect(authorization_url(current_app.config["GOOGLE_CLIENT_ID"],
                                      _redirect_uri(), state))


@bp.get("/auth/google/callback")
def google_callback():
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
    user = accounts.upsert_from_claims(claims)
    next_path = _safe_next(session.pop("oauth_next", None))
    session.clear()                              # session fixation: full reset on sign-in
    session["uid"] = user["id"]
    return redirect("/?welcome=1" if user["status"] == "pending" else next_path)


@bp.post("/auth/dev")
def dev_login():
    """Development-only e-mail sign-in (DEV_LOGIN=1, never in production)."""
    if not current_app.config.get("DEV_LOGIN"):
        abort(404)
    body = request.get_json(silent=True) or {}
    try:
        user = accounts.create_dev_user(body.get("email") or "", body.get("name") or "",
                                        body.get("role") or "")
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400
    session.clear()
    session["uid"] = user["id"]
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
