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
from models import Study, get_db, now
from routes.helpers import json_body

bp = Blueprint("console", __name__)


# --------------------------------------------------------------------- admin portal
ACTION_LABELS = {
    "auth/signin": ("Signed in", "signin"),
    "auth/register": ("Registered an account", "account"),
    "console/decision": ("Account decision", "account"),
    "console/role": ("Changed a role", "account"),
    "/api/studio/save": ("Edited a design", "design"),
    "/api/studio/status": ("Changed study status", "design"),
    "/api/studio/delete": ("Deleted a study", "design"),
    "/api/studio/duplicate": ("Duplicated a study", "design"),
    "/api/studio/launch": ("Launched fieldwork", "field"),
    "/api/studio/relaunch": ("Relaunched fieldwork", "field"),
    "/api/studio/pause": ("Paused fieldwork", "field"),
    "/api/studio/remind": ("Sent reminders", "field"),
    "/api/workspace/publish": ("Published a version", "design"),
    "/api/workspace/review": ("Reviewed a version", "design"),
    "/api/workspace/comments": ("Left a comment", "design"),
    "/api/workspace/export": ("Exported data", "data"),
    "/api/workspace/export_ppt": ("Exported a deck", "data"),
    "/api/workspace/verbatims": ("Read verbatims", "data"),
    "/admin/export": ("Downloaded an extract", "data"),
    "/api/admin/console": ("Used the admin console", "account"),
    "/api/start": ("Started a test run", "field"),
}


def _action_label(path: str) -> tuple[str, str]:
    for prefix, out in ACTION_LABELS.items():
        if path.startswith(prefix):
            return out
    return ("Activity: " + (path or "?"), "other")


def _daily_series(rows, day_key="created_at", n=14):
    """Counts per calendar day for the last n days, oldest first."""
    from datetime import date, timedelta
    from collections import Counter
    days = [(date.today() - timedelta(days=i)).isoformat() for i in range(n - 1, -1, -1)]
    counts = Counter(str(r[day_key] or "")[:10] for r in rows)
    return [{"day": d[5:], "n": counts.get(d, 0)} for d in days]


@bp.get("/admin-portal")
def admin_portal():
    """Usage & user-activity dashboard for the platform admin.

    Open without login for design review (sample phase); when access rules are
    finalised this route will require an approved admin account - the boundary
    carves it out publicly until then.
    """
    users = accounts.list_users()
    db = get_db()
    events = [dict(r) for r in db.execute(
        "SELECT actor, action, study, created_at, detail FROM audit_events "
        "ORDER BY id DESC LIMIT 60").fetchall()]
    per_actor = {}
    for e in events:
        per_actor[e["actor"]] = per_actor.get(e["actor"], 0) + 1
    from datetime import date, timedelta
    today = now()[:10]
    week_ago = (date.today() - timedelta(days=6)).isoformat()
    for u in users:
        u["events"] = per_actor.get(u["email"], 0)
    stats = {
        "users": len(users),
        "pending": sum(1 for u in users if u["status"] == "pending"),
        "approved": sum(1 for u in users if u["status"] == "approved"),
        "admins": sum(1 for u in users if u["role"] == "admin"),
        "projects": db.execute("SELECT COUNT(*) FROM studies").fetchone()[0],
        "completes": db.execute(
            "SELECT COUNT(*) FROM respondents WHERE status='complete'").fetchone()[0],
        "events_today": sum(1 for e in events if str(e["created_at"])[:10] == today),
        "active_week": len({e["actor"] for e in events
                            if str(e["created_at"])[:10] >= week_ago and e["actor"]}),
    }
    feed = []
    for e in events[:28]:
        label, kind = _action_label(e["action"])
        feed.append({"who": e["actor"] or "—", "label": label, "kind": kind,
                     "study": e["study"] or "", "at": (e["created_at"] or "").replace("T", " ")[:16],
                     "detail": e["detail"] or ""})
    signups = _daily_series(users)
    activity = _daily_series(events)
    peak = max((x["n"] for x in signups + activity), default=1) or 1
    return render_template("admin/portal.html", users=users, stats=stats, feed=feed,
                           signups=signups, activity=activity, peak=peak)


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
