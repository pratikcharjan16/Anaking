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

Account desk (one account in every context)
    GET  /api/admin/console/account?user_id=     profile + projects + Kart ledger + audit trail
    POST /api/admin/console/profile              {user_id, name?, email?, username?}
    POST /api/admin/console/delete               {user_id} - only when the account owns nothing
    POST /api/admin/console/impersonate          {user_id} - audited support view ("open as user")
    POST /auth/impersonate/end                   leave the support view, back to the desk

Sign-in & recovery (the "forgot username / password" queue)
    GET  /api/admin/console/recovery             pending recovery links + counts
    POST /api/admin/console/recovery/issue       {user_id} - create a one-time link and return it
    POST /api/admin/console/recovery/decide      {reset_id, action: handed_over|revoke}

All rights reserved to Admin (Anaking.admin).
"""

from __future__ import annotations

from flask import (Blueprint, abort, current_app, g, jsonify, redirect,
                   render_template, request, session)

import core.accounts as accounts
import core.recovery as recovery
from core.kart import decide_point_request, list_point_requests
from core.mailer import smtp_settings
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
    "console/profile": ("Edited an account identity", "account"),
    "console/delete-account": ("Deleted an account", "account"),
    "console/impersonate": ("Opened a support view", "account"),
    "console/impersonate-end": ("Left a support view", "account"),
    "console/recovery-issue": ("Issued a recovery link", "account"),
    "console/recovery-handover": ("Handed over a recovery link", "account"),
    "console/recovery-revoke": ("Revoked a recovery link", "account"),
    "auth/recover-request": ("Requested a sign-in recovery link", "account"),
    "auth/password-reset": ("Set a new password", "account"),
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


@bp.app_template_global("support_mode")
def support_mode_global() -> dict | None:
    """The audited support view the admin is currently inside, if any.

    Templates render a strip with the account being viewed and a way out, so nobody
    can mistake a user's workspace for their own admin session.
    """
    imp = session.get("impersonator")
    if not imp:
        return None
    user = accounts.by_id(session.get("uid")) if session.get("uid") else None
    return {"admin_email": imp.get("email") or "admin", "started": imp.get("started") or "",
            "user": user}


def _account_or_404(user_id):
    user = accounts.by_id(user_id)
    if not user:
        abort(404, "unknown user")
    return user


def _public_user(user: dict | None) -> dict:
    """A profile payload that is safe to send back to the browser.

    ``accounts.by_id`` returns the whole row, password hash included; admin actions
    answer with the updated profile, so the hash is stripped here — the desk never
    needs it and it must never travel over the wire.
    """
    out = dict(user or {})
    out.pop("password_hash", None)
    return out


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
        "pending_recovery": len(recovery.pending_requests()),
        "users_db": (__import__("core.userdata", fromlist=["x"]).describe())["users_db"],
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
        "pending_recovery": len(recovery.pending_requests()),
        "users_db": (__import__("core.userdata", fromlist=["x"]).describe())["users_db"],
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
    return jsonify({"ok": True, "user": _public_user(updated)})


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
    return jsonify({"ok": True, "user": _public_user(updated)})


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


# ====================================================================================
# ACCOUNT DESK — one account in every context
# ====================================================================================
@bp.get("/api/admin/console/account")
def account_desk_detail():
    """Everything the desk shows for one account, in a single request."""
    _require_admin()
    try:
        user_id = int(request.args.get("user_id") or 0)
    except ValueError:
        abort(400, "user_id must be a number")
    detail = accounts.account_detail(user_id)
    if not detail:
        abort(404, "unknown user")
    detail["peers"] = [
        {"id": u["id"], "name": u["name"] or u["username"] or u["email"], "email": u["email"],
         "role": u["role"], "status": u["status"]}
        for u in accounts.list_users() if u["id"] != user_id
    ]
    return jsonify(detail)


@bp.post("/api/admin/console/profile")
def account_profile_update():
    """Admin edit of a display name, e-mail or username (validated + de-duplicated)."""
    adm = _require_admin()
    body = json_body()
    user = _account_or_404(body.get("user_id") or 0)
    try:
        updated = accounts.update_profile(
            user["id"],
            name=body["name"] if "name" in body else None,
            email=body["email"] if "email" in body else None,
            username=body["username"] if "username" in body else None,
        )
    except ValueError as exc:
        abort(400, str(exc))
    audit("console/profile", detail=f"{user['email']} -> {updated['email']}")
    return jsonify({"ok": True, "user": _public_user(updated), "by": adm.get("email", "admin")})


@bp.post("/api/admin/console/delete")
def account_delete():
    """Delete an account that owns nothing. Projects must be transferred first."""
    _require_admin()
    body = json_body()
    user = _account_or_404(body.get("user_id") or 0)
    me = getattr(g, "user", None)
    if me and me.get("id") == user["id"]:
        abort(400, "You cannot delete the account you are signed in with.")
    try:
        deleted = accounts.delete_user(user["id"])
    except ValueError as exc:
        abort(400, str(exc))
    audit("console/delete-account", detail=f"{deleted['email']} (#{deleted['id']}) deleted")
    return jsonify({"ok": True, "deleted": deleted})


@bp.post("/api/admin/console/impersonate")
def account_impersonate():
    """Audited support view: open SurveyKart exactly as this person sees it.

    A platform admin only. The admin's own uid is parked in the session and restored
    on exit, so the admin never loses their way back. Admin accounts are refused -
    there is nothing to support there, and it would be a privilege-laundering path.
    """
    adm = _require_admin()
    if session.get("staff_id"):
        abort(400, "Open the support view from a platform admin account, not staff auth.")
    if session.get("impersonator"):
        abort(400, "You are already inside a support view. Exit it first.")
    body = json_body()
    user = _account_or_404(body.get("user_id") or 0)
    if user["role"] == "admin" or accounts.is_protected_admin(user):
        abort(400, "Admin accounts cannot be opened in support view.")
    if user["status"] != "approved":
        abort(400, "Only an approved account can be opened in support view.")
    session["impersonator"] = {"email": adm.get("email") or "admin",
                               "uid": session.get("uid"), "started": now()}
    session["uid"] = user["id"]
    audit("console/impersonate", detail=f"{user['email']} opened in support view")
    return jsonify({"ok": True, "redirect": "/workspace/",
                    "user": {"id": user["id"], "name": user["name"], "email": user["email"]}})


@bp.post("/auth/impersonate/end")
def account_impersonate_end():
    """Leave the support view and land back on the account desk."""
    imp = session.pop("impersonator", None)
    if not imp:
        abort(400, "Not in a support view.")
    if imp.get("uid"):
        session["uid"] = imp["uid"]
    else:
        session.pop("uid", None)
    with get_db() as db:
        db.execute("INSERT INTO audit_events(actor,action,study,created_at,detail) "
                   "VALUES(?,?,?,?,?)",
                   (imp.get("email") or "admin", "console/impersonate-end", "", now(),
                    "left the support view"))
    return redirect("/admin/console")


# ====================================================================================
# SIGN-IN & RECOVERY
# ====================================================================================
@bp.get("/api/admin/console/recovery")
def recovery_queue():
    """One-time recovery links waiting for a human (no SMTP configured) + the tally."""
    _require_admin()
    pending = recovery.pending_requests()
    return jsonify({
        "pending": pending,
        "count": len(pending),
        "mail_configured": bool(smtp_settings()),
        "ttl_minutes": recovery.TOKEN_TTL_MINUTES,
    })


@bp.post("/api/admin/console/recovery/issue")
def recovery_issue():
    """Create a fresh one-time link for an account (shown once, to this admin)."""
    adm = _require_admin()
    body = json_body()
    user = _account_or_404(body.get("user_id") or 0)
    if user["role"] == "admin" and accounts.is_protected_admin(user):
        abort(400, "The master admin signs in with ADMIN_PASSWORD — change it in .env instead.")
    issued = recovery.issue(user, requested_by=adm.get("email", "admin"),
                            requested_ip=request.remote_addr or "",
                            note="issued by the admin")
    audit("console/recovery-issue", detail=f"{user['email']} — link {issued['delivered']}")
    return jsonify({
        "ok": True,
        "id": issued["id"],
        "link": recovery.absolute_link(issued["link"]),
        "delivery": issued["delivered"],
        "expires_at": issued["expires_at"],
        "message": ("E-mailed to " + user["email"]) if issued["delivered"] == "email"
                   else "No mail server configured — copy this link and send it to the user.",
    })


@bp.post("/api/admin/console/recovery/decide")
def recovery_decide():
    """``handed_over`` records that the admin sent the link on; ``revoke`` kills it."""
    adm = _require_admin()
    body = json_body()
    try:
        reset_id = int(body.get("reset_id") or 0)
    except (TypeError, ValueError):
        abort(400, "reset_id must be a number")
    action = str(body.get("action") or "")
    try:
        if action == "handed_over":
            row = recovery.mark_handed_over(reset_id, by=adm.get("email", "admin"))
            audit("console/recovery-handover", detail=f"recovery #{reset_id}")
        elif action == "revoke":
            row = recovery.revoke(reset_id)
            audit("console/recovery-revoke", detail=f"recovery #{reset_id}")
        else:
            abort(400, "action must be handed_over or revoke")
    except ValueError as exc:
        abort(400, str(exc))
    return jsonify({"ok": True, "reset": row})
