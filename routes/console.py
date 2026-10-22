"""
Admin console - who is on the platform, and what they have built.

    GET  /admin/console                    the console page (platform admins only)
    GET  /api/admin/console/overview       stats + every profile with its project counts
    GET  /api/admin/console/projects?user_id=   what one account has built
    POST /api/admin/console/decision       {user_id, decision: approve|reject|disable|enable}
    POST /api/admin/console/role           {user_id, role: user|admin}

One profile per Google e-mail; every new profile waits here for the admin's yes.
Approving is what grants access to the workspace - rejected and disabled profiles
cannot use the team apps (respondent survey links stay public either way).
"""

from __future__ import annotations

from flask import Blueprint, abort, g, jsonify, render_template, request

import core.accounts as accounts
from core.security import audit
from models import Study, get_db
from routes.helpers import json_body

bp = Blueprint("console", __name__)


def _require_admin() -> dict:
    """Platform admin only.  With the boundary off (local dev) everything is open."""
    user = getattr(g, "user", None)
    if user is not None and user.get("role") != "admin":
        abort(403, "The admin console is for platform admins.")
    return user or {"email": "local-preview", "role": "admin"}


@bp.get("/admin/console")
def console_page():
    _require_admin()
    return render_template("admin/console.html")


@bp.get("/api/admin/console/overview")
def overview():
    _require_admin()
    users = accounts.list_users()
    stats = {
        "users": len(users),
        "pending": sum(1 for u in users if u["status"] == "pending"),
        "approved": sum(1 for u in users if u["status"] == "approved"),
        "admins": sum(1 for u in users if u["role"] == "admin"),
        "projects": get_db().execute("SELECT COUNT(*) FROM studies").fetchone()[0],
        "owned_projects": get_db().execute(
            "SELECT COUNT(*) FROM studies WHERE owner_id != 0").fetchone()[0],
        "completes": get_db().execute(
            "SELECT COUNT(*) FROM respondents WHERE status='complete'").fetchone()[0],
    }
    return jsonify({"stats": stats, "users": users})


@bp.get("/api/admin/console/projects")
def projects_of():
    _require_admin()
    try:
        user_id = int(request.args.get("user_id") or 0)
    except ValueError:
        abort(400, "user_id must be a number")
    if not accounts.by_id(user_id):
        abort(404, "unknown user")
    out = accounts.projects_of(user_id)
    counts = {s["slug"]: s for s in Study.list_with_counts()}
    for p in out:
        row = counts.get(p["slug"]) or {}
        p["started"] = row.get("started", 0)
        p["study_id"] = row.get("study_id", "")
    return jsonify({"projects": out})


@bp.post("/api/admin/console/decision")
def decision():
    _require_admin()
    body = json_body()
    user = accounts.by_id(body.get("user_id") or 0)
    if not user:
        abort(404, "unknown user")
    decision = str(body.get("decision") or "")
    mapped = {"approve": "approved", "reject": "rejected",
              "disable": "disabled", "enable": "approved"}
    if decision not in mapped:
        abort(400, "decision must be approve, reject, disable or enable")
    if user["role"] == "admin" and mapped[decision] != "approved":
        if accounts.count_admins() <= 1:
            abort(400, "The last admin cannot be locked out.")
    updated = accounts.set_status(user["id"], mapped[decision],
                                  approved_by=(getattr(g, "user", None) or {}).get("email", ""))
    audit("console/decision", detail=f"{user['email']} -> {mapped[decision]}")
    return jsonify({"ok": True, "user": updated})


@bp.post("/api/admin/console/role")
def role():
    _require_admin()
    body = json_body()
    user = accounts.by_id(body.get("user_id") or 0)
    if not user:
        abort(404, "unknown user")
    role = str(body.get("role") or "")
    if role not in accounts.ROLES:
        abort(400, "role must be user or admin")
    if user["role"] == "admin" and role == "user" and accounts.count_admins() <= 1:
        abort(400, "The last admin cannot be demoted.")
    updated = accounts.set_role(user["id"], role)
    audit("console/role", detail=f"{user['email']} -> {role}")
    return jsonify({"ok": True, "user": updated})
