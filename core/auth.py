"""Admin-token guard shared by the Studio and Admin blueprints."""

from __future__ import annotations

import hmac
from functools import wraps

from flask import abort, current_app, jsonify, request


def token_ok(token: str | None = None) -> bool:
    supplied = token if token is not None else (
        request.args.get("token") or request.headers.get("X-Admin-Token") or "")
    return hmac.compare_digest(supplied, current_app.config["ADMIN_TOKEN"])


def admin_required(kind: str = "json"):
    """Reject the request with 403 unless ``?token=`` matches ``ADMIN_TOKEN``.

    ``kind`` controls the error body: ``json`` for API endpoints, ``text`` for pages.
    """
    def deco(fn):
        @wraps(fn)
        def wrapper(*a, **kw):
            if not token_ok():
                if kind == "json":
                    return jsonify({"error": "unauthorised"}), 403
                abort(403, "admin token required (?token=...)")
            return fn(*a, **kw)
        return wrapper
    return deco
