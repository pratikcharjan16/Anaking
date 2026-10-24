"""
Admin console & Admin portal — protected SurveyKart control center.

    GET  /admin/console                          the console page (platform admins only)
    GET  /admin-portal                           usage & user activity dashboard (admins only)
    GET  /api/admin/console/overview             stats + every profile + Kart points + requests
    GET  /api/admin/console/projects?user_id=    what one account has built + Kart usage
    POST /api/admin/console/project/owner        transfer or take ownership of a project
    POST /api/admin/console/decision             {user_id, decision: approve|reject|disable|enable, points?: welcome pts on approve (default 100)}
    POST /api/admin/console/role                 {user_id, role: user|admin}
    POST /api/admin/console/points               {user_id, delta?, points_limit?, reason?}
    POST /api/admin/console/point-requests/decide {request_id, decision: approve|reject, points?}

All rights reserved to Admin (Anaking.admin).
"""

from __future__ import annotations

from flask import Blueprint, abort, current_app, g, jsonify, render_template, request

import core.accounts as accounts
from core.kart import decide_point_request, list_point_requests
from core.security import audit
from models import Study, StudyError, get_db, now
from routes.helpers import json_body

bp = Blueprint("console", __name__)


ACTION_LABELS = {
    "auth/signin": ("Signed in", "signin"),
    "auth/admin-signin": ("Admin signed in (Admin Login)", "signin"),
    "auth/register": ("Registered on SurveyKart", "account"),
    "auth/approval-request": ("Requested account approval (100 pts on approval)", "account"),
    "console/decision": ("Account decision", "account"),
    "console/role": ("Changed a role", "account"),
    "console/points": ("Adjusted Kart points", "account"),
    "console/point-request": ("Processed Kart point request", "account"),
    "kart/request-points": ("Requested extra Kart points", "account"),
    "share/create": ("Shared a project link", "design"),
    "share/redeem": ("Opened shared link (0 pts debited)", "design"),
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


def _require_admin() -> dict:
    """Platform admin only. With STAFF_AUTH off (unit-test harness), returns preview admin."""
    user = getattr(g, "user", None)
    staff = getattr(g, "staff", None)
    if user is not None:
        if user.get("role") != "admin":
            abort(403, "All rights reserved to Admin.")
        return user
    if staff is not None:
        if staff.get("role") != "owner":
            abort(403, "All rights reserved to Admin.")
        return {"email": staff.get("username", "admin"), "role": "admin"}
    if current_app.config.get("STAFF_AUTH"):
        abort(401, "Admin sign-in required.")
    return {"email": "local-preview", "role": "admin"}


@bp.get("/admin-portal")
def admin_portal():
    """Protected usage, Kart points & user-activity dashboard for the SurveyKart admin."""
    _require_admin()
    users = accounts.list_users()
    point_reqs = list_point_requests()
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
        "pending_point_requests": sum(1 for r in point_reqs if r["status"] == "pending"),
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
                           signups=signups, activity=activity, peak=peak,
                           point_requests=point_reqs)


@bp.get("/admin/console")
def console_page():
    _require_admin()
    return render_template("admin/console.html")


@bp.get("/api/admin/console/overview")
def overview():
    _require_admin()
    users = accounts.list_users()
    point_reqs = list_point_requests()
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
        "pending_point_requests": sum(1 for r in point_reqs if r["status"] == "pending"),
        "shared_links": get_db().execute("SELECT COUNT(*) FROM study_shares").fetchone()[0],
    }
    return jsonify({"stats": stats, "users": users, "point_requests": point_reqs})


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
        p["owner_email"] = row.get("owner_email", "")
    return jsonify({"projects": out})


@bp.post("/api/admin/console/project/owner")
def project_owner():
    _require_admin()
    body = json_body()
    slug = str(body.get("slug") or "")
    study = Study.get(slug)
    if not study:
        abort(404, "unknown study")
    target = body.get("user_id")
    if target:
        user = accounts.by_id(int(target))
        if not user:
            abort(404, "unknown user")
        owner_id = user["id"]
    else:
        me = getattr(g, "user", None)
        if not me:
            abort(400, "No signed-in admin account to take ownership.")
        owner_id = me["id"]
    with get_db() as db:
        db.execute("UPDATE studies SET owner_id=? WHERE slug=?", (owner_id, slug))
    audit("console/project-owner", study=slug, detail=f"owner -> {owner_id}")
    return jsonify({"ok": True, "slug": slug, "owner_id": owner_id})


@bp.post("/api/admin/console/decision")
def decision():
    """Approve / reject / disable / enable an account.

    Approving accepts the optional ``points`` welcome allocation (default
    100 Kart pts): the one-time grant lands in the user's Kart in the same
    action, exactly once (accounts.set_status owns the rule)."""
    adm = _require_admin()
    body = json_body()
    user = accounts.by_id(body.get("user_id") or 0)
    if not user:
        abort(404, "unknown user")
    decision_val = str(body.get("decision") or "")
    mapped = {"approve": "approved", "reject": "rejected",
              "disable": "disabled", "enable": "approved"}
    if decision_val not in mapped:
        abort(400, "decision must be approve, reject, disable or enable")
    if user["role"] == "admin" and mapped[decision_val] != "approved":
        if accounts.count_admins() <= 1:
            abort(400, "The last admin cannot be locked out.")
    points_raw = body.get("points")
    try:
        welcome_points = int(points_raw) if points_raw not in (None, "") else None
    except (TypeError, ValueError):
        abort(400, "points must be a number")
    try:
        updated = accounts.set_status(user["id"], mapped[decision_val],
                                      approved_by=adm.get("email", "admin"),
                                      welcome_points=welcome_points)
    except ValueError as exc:
        abort(400, str(exc))
    granted = int(updated.pop("welcome_points_granted", 0) or 0)
    updated.pop("password_hash", None)
    from core.kart import user_points_usage
    used = user_points_usage(updated["id"])
    updated["points_used"] = used
    updated["points_balance"] = (accounts.ADMIN_UNLIMITED_POINTS if updated["role"] == "admin"
                                 else max(0, int(updated["points_limit"]) - used))
    updated["welcome_points_pending"] = accounts.welcome_points_pending(updated)
    detail = f"{user['email']} -> {mapped[decision_val]}"
    if mapped[decision_val] == "approved" and granted:
        detail += f" (+{granted} Kart pts welcome allocation)"
    audit("console/decision", detail=detail)
    if mapped[decision_val] == "approved":
        accounts.notify_user_approved(updated, granted)
    return jsonify({"ok": True, "user": updated, "welcome_points_granted": granted})


@bp.post("/api/admin/console/role")
def role():
    _require_admin()
    body = json_body()
    user = accounts.by_id(body.get("user_id") or 0)
    if not user:
        abort(404, "unknown user")
    role_val = str(body.get("role") or "")
    if role_val not in accounts.ROLES:
        abort(400, "role must be user or admin")
    if user["role"] == "admin" and role_val == "user" and accounts.count_admins() <= 1:
        abort(400, "The last admin cannot be demoted.")
    try:
        updated = accounts.set_role(user["id"], role_val)
    except ValueError as exc:
        abort(400, str(exc))
    audit("console/role", detail=f"{user['email']} -> {role_val}")
    return jsonify({"ok": True, "user": updated})


@bp.post("/api/admin/console/points")
def manage_points():
    """Admin increases or decreases (or sets exact limit of) Kart points for any user."""
    adm = _require_admin()
    body = json_body()
    try:
        uid = int(body.get("user_id") or 0)
    except (TypeError, ValueError):
        abort(400, "Invalid user_id")
    user = accounts.by_id(uid)
    if not user:
        abort(404, "unknown user")
    new_limit = body.get("points_limit")
    delta = body.get("delta")
    reason = str(body.get("reason") or "").strip()
    try:
        if new_limit is not None and new_limit != "":
            updated = accounts.adjust_points(
                uid, new_limit=int(new_limit), reason=reason or "Admin set Kart point limit",
                actor=adm.get("email", "admin")
            )
        elif delta is not None and delta != "":
            updated = accounts.adjust_points(
                uid, delta=int(delta), reason=reason or f"Admin adjusted Kart points ({int(delta):+d})",
                actor=adm.get("email", "admin")
            )
        else:
            abort(400, "Provide delta or points_limit")
    except (TypeError, ValueError) as exc:
        abort(400, str(exc))
    from core.kart import user_points_usage
    used = user_points_usage(uid)
    updated["points_used"] = used
    updated["points_balance"] = max(0, int(updated["points_limit"]) - used)
    audit("console/points", detail=f"{user['email']} -> limit {updated['points_limit']} pts")
    return jsonify({"ok": True, "user": updated})


@bp.post("/api/admin/console/point-requests/decide")
def point_request_decision():
    """Admin approves or rejects a user's request for additional Kart points."""
    adm = _require_admin()
    body = json_body()
    try:
        req_id = int(body.get("request_id") or 0)
        dec = str(body.get("decision") or "")
        pts_override = body.get("points")
        pts_val = int(pts_override) if (pts_override is not None and pts_override != "") else None
        out = decide_point_request(req_id, dec, actor_email=adm.get("email", "admin"), override_points=pts_val)
    except StudyError as exc:
        return jsonify({"error": exc.message}), exc.status
    except (TypeError, ValueError) as exc:
        abort(400, str(exc))
    audit("console/point-request", detail=f"request #{req_id} -> {dec}")
    return jsonify({"ok": True, "request": out})
