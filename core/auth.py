"""Admin authentication shared by the Studio and Admin blueprints.

Two ways to be authorised:

* **Signed-in session** - the research team enters the admin token once on ``/login``
  (or the home page); a signed cookie then covers Studio, Admin and draft previews.
* **Explicit token** - ``?token=<ADMIN_TOKEN>`` or the ``X-Admin-Token`` header, for
  scripts, bookmarks and the URLs printed at start-up.  Visiting a page with a valid
  ``?token=`` also signs the browser in, so later navigation needs no token.
"""

from __future__ import annotations

import hmac
from functools import wraps

from flask import abort, current_app, jsonify, redirect, request, session, url_for

SESSION_KEY = "admin"


def _matches(token: str | None) -> bool:
    return bool(token) and hmac.compare_digest(str(token), current_app.config["ADMIN_TOKEN"])


def sign_in(token: str | None) -> bool:
    """Start an admin session if ``token`` is right. Returns whether it was."""
    if not _matches(token):
        return False
    session[SESSION_KEY] = True
    session.permanent = True
    return True


def sign_out() -> None:
    session.pop(SESSION_KEY, None)


def is_signed_in() -> bool:
    return bool(session.get(SESSION_KEY))


def token_ok(token: str | None = None, remember: bool = False) -> bool:
    """True if an explicit token matches or the browser holds an admin session.

    ``remember=True`` (used by page views) also signs the browser in when a valid
    ``?token=`` is supplied, so the old bookmarked links keep working *and* every
    later click needs no token.  API calls never create a session.
    """
    supplied = token if token is not None else (
        request.args.get("token") or request.headers.get("X-Admin-Token") or "")
    if _matches(supplied):
        if remember and not is_signed_in():
            sign_in(supplied)
        return True
    return is_signed_in()


def admin_required(kind: str = "json"):
    """Guard a view.

    ``kind="json"`` (APIs)       -> ``403 {"error": "unauthorised"}``
    ``kind="text"`` (downloads)  -> plain-text 403
    ``kind="page"`` (HTML pages) -> redirect the browser to the sign-in form
    """
    def deco(fn):
        @wraps(fn)
        def wrapper(*a, **kw):
            if not token_ok(remember=(kind != "json")):
                if kind == "json":
                    return jsonify({"error": "unauthorised"}), 403
                if kind == "page" and request.method == "GET":
                    return redirect(url_for("home.login", next=request.full_path.rstrip("?")))
                abort(403, "admin sign-in required (?token=... or /login)")
            return fn(*a, **kw)
        return wrapper
    return deco
