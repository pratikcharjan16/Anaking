"""
"Request a demo" - a public lead form, kept apart from account approvals.

A demo request is *not* a registration: it creates no account, grants no Kart
points and never appears in the "Waiting on you" approval queue.  It has its own
table (``demo_requests``), its own statuses and its own panel in the admin console,
so the team can work sales leads without mixing them into access decisions.

Endpoints
---------
POST /api/demo/request                      public, rate-limited, honeypot-guarded
GET  /api/demo/config                       what the landing page should show
GET  /api/admin/console/demo-requests       admin: the queue and its counts
POST /api/admin/console/demo-requests/decide  admin: status + note
POST /api/admin/console/demo-requests/delete  admin: remove an obvious spam row
"""

from __future__ import annotations

import re
from datetime import datetime, timedelta

from flask import Blueprint, current_app, g, jsonify, request

from core import mailer
from core.security import actor, audit
from models import get_db, now

bp = Blueprint("demo", __name__)

EMAIL_RE = re.compile(r"^[^@\s,;<>]{1,64}@[^@\s,;<>]{1,190}\.[A-Za-z]{2,}$")
STATUSES = ("new", "contacted", "scheduled", "closed")
MAX_PER_EMAIL_HOUR = 3
MAX_PER_IP_HOUR = 10


def _clean(value, limit: int) -> str:
    return re.sub(r"\s+", " ", str(value or "")).strip()[:limit]


def _admin() -> dict:
    user = getattr(g, "user", None)
    staff = getattr(g, "staff", None)
    if user is not None:
        if user.get("role") != "admin":
            from flask import abort
            abort(403, "All rights reserved to Admin.")
        return user
    if staff is not None:
        if staff.get("role") != "owner":
            from flask import abort
            abort(403, "All rights reserved to Admin.")
        return {"email": staff.get("username", "admin"), "role": "admin"}
    if current_app.config.get("STAFF_AUTH"):
        from flask import abort
        abort(401, "Admin sign-in required.")
    return {"email": "local-preview", "role": "admin"}


def _recent(db, column: str, value: str, hours: int = 1) -> int:
    since = (datetime.now() - timedelta(hours=hours)).strftime("%Y-%m-%dT%H:%M:%S")
    row = db.execute(f"SELECT COUNT(*) FROM demo_requests WHERE {column}=? AND created_at>=?",
                     (value, since)).fetchone()
    return int(row[0] if row else 0)


def _notify(row: dict) -> str:
    """Tell the team. Best effort: the request is stored even with no SMTP."""
    recipients = list(current_app.config.get("DEMO_NOTIFY_EMAIL") or [])
    if not recipients or not mailer.smtp_settings():
        return "queued" if recipients else "no-recipient"
    subject = f"Demo request: {row['organization'] or row['name']}"
    body = "\n".join([
        "A demo of SurveyKart was requested from the landing page.", "",
        f"Name:         {row['name']}",
        f"Work e-mail:  {row['email']}",
        f"Organisation: {row['organization'] or '-'}",
        f"Role:         {row['role'] or '-'}",
        f"Team size:    {row['team_size'] or '-'}",
        "", "What they want to see:", row["message"] or "(no message)", "",
        "Open the account desk -> Demo requests to mark it contacted.",
        "", f"Request id {row['id']} · received {row['created_at']}",
    ])
    sent = 0
    for to in recipients:
        try:
            mailer.send_mail(to, subject, body)
            sent += 1
        except mailer.MailError:
            continue
    return "sent" if sent else "failed"


@bp.get("/api/demo/config")
def demo_config():
    """Small public payload so the landing page can word the form honestly."""
    return jsonify({
        "ok": True,
        "notify_configured": bool(current_app.config.get("DEMO_NOTIFY_EMAIL")),
        "smtp_configured": bool(mailer.smtp_settings()),
        "statuses": list(STATUSES),
    })


@bp.post("/api/demo/request")
def demo_request():
    body = request.get_json(silent=True) or {}
    if not isinstance(body, dict):
        return jsonify({"error": "Send a JSON object."}), 400
    if str(body.get("website") or "").strip():        # honeypot: humans never fill it
        return jsonify({"ok": True, "received": False})
    name = _clean(body.get("name"), 80)
    email = _clean(body.get("email"), 254).lower()
    org = _clean(body.get("organization"), 120)
    role = _clean(body.get("role"), 60)
    team = _clean(body.get("team_size"), 40)
    message = str(body.get("message") or "").strip()[:2000]
    if len(name) < 2:
        return jsonify({"error": "Please tell us your name."}), 400
    if not EMAIL_RE.match(email):
        return jsonify({"error": "That e-mail address does not look right."}), 400
    if not org:
        return jsonify({"error": "Please add your organisation."}), 400

    db = get_db()
    ip = (request.headers.get("X-Forwarded-For") or request.remote_addr or "").split(",")[0].strip()
    if _recent(db, "email", email) >= MAX_PER_EMAIL_HOUR:
        return jsonify({"error": "We already have your request - the team will be in touch."}), 429
    dup = db.execute("SELECT id FROM demo_requests WHERE email=? AND status!='closed' "
                     "ORDER BY id DESC LIMIT 1", (email,)).fetchone()
    if dup:
        return jsonify({"ok": True, "received": True, "duplicate": True,
                        "message": "You already have a demo request open - the team will reply soon."})
    if ip and _recent(db, "ip", ip) >= MAX_PER_IP_HOUR:
        return jsonify({"error": "Too many requests from this connection - try again later."}), 429

    stamp = now()
    cur = db.execute(
        "INSERT INTO demo_requests (name, email, organization, role, team_size, message, "
        "source, ip, status, note, handled_by, created_at, updated_at) "
        "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
        (name, email, org, role, team, message, _clean(body.get("source"), 40) or "landing",
         ip[:60], "new", "", "", stamp, stamp))
    db.commit()
    row = dict(db.execute("SELECT * FROM demo_requests WHERE id=?", (cur.lastrowid,)).fetchone())
    outcome = _notify(row)
    db.execute("UPDATE demo_requests SET note=? WHERE id=?",
               (f"notify:{outcome}", row["id"]))
    db.commit()
    audit("Requested a SurveyKart demo", detail=f"{email} · {org}"[:300])
    return jsonify({"ok": True, "received": True, "id": row["id"],
                    "notified": outcome in ("sent", "queued"),
                    "message": "Thank you - the SurveyKart team will contact you shortly."})


@bp.get("/api/admin/console/demo-requests")
def demo_requests():
    _admin()
    db = get_db()
    rows = [dict(r) for r in db.execute(
        "SELECT * FROM demo_requests ORDER BY CASE status WHEN 'new' THEN 0 ELSE 1 END, id DESC "
        "LIMIT 300").fetchall()]
    counts = {s: 0 for s in STATUSES}
    for r in rows:
        counts[r["status"]] = counts.get(r["status"], 0) + 1
    return jsonify({"requests": rows, "counts": counts, "total": len(rows),
                    "smtp_configured": bool(mailer.smtp_settings())})


@bp.post("/api/admin/console/demo-requests/decide")
def demo_decide():
    user = _admin()
    body = request.get_json(silent=True) or {}
    try:
        rid = int(body.get("id") or 0)
    except (TypeError, ValueError):
        return jsonify({"error": "id must be a number"}), 400
    status = str(body.get("status") or "").strip()
    if status not in STATUSES:
        return jsonify({"error": "unknown status"}), 400
    note = str(body.get("note") or "").strip()[:1000]
    db = get_db()
    row = db.execute("SELECT * FROM demo_requests WHERE id=?", (rid,)).fetchone()
    if not row:
        return jsonify({"error": "unknown demo request"}), 404
    db.execute("UPDATE demo_requests SET status=?, note=?, handled_by=?, updated_at=? WHERE id=?",
               (status, note or row["note"], user.get("email") or actor(), now(), rid))
    db.commit()
    audit(f"Demo request marked {status}", detail=str(row["email"])[:300])
    return jsonify({"ok": True, "request": dict(db.execute(
        "SELECT * FROM demo_requests WHERE id=?", (rid,)).fetchone())})


@bp.post("/api/admin/console/demo-requests/delete")
def demo_delete():
    user = _admin()
    body = request.get_json(silent=True) or {}
    try:
        rid = int(body.get("id") or 0)
    except (TypeError, ValueError):
        return jsonify({"error": "id must be a number"}), 400
    db = get_db()
    row = db.execute("SELECT * FROM demo_requests WHERE id=?", (rid,)).fetchone()
    if not row:
        return jsonify({"error": "unknown demo request"}), 404
    db.execute("DELETE FROM demo_requests WHERE id=?", (rid,))
    db.commit()
    audit("Removed a demo request", detail=str(row["email"])[:300])
    return jsonify({"ok": True, "deleted": rid, "by": user.get("email") or actor()})
