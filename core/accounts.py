"""
Platform accounts - one profile per e-mail address, approved by an admin.

Everyone signs in with Google.  The first sign-in creates a **pending** profile; the
platform admin (emails listed in ``ADMIN_EMAILS``, promoted in the console) approves
or rejects it.  Approved users see and build only their own projects; admins see
everything and manage the people.  A rejected or disabled profile cannot use the
team apps at all (respondent survey links are always public - fieldwork never
signs in).

The identity is the Google e-mail: one row per address no matter how often or from
where someone signs in.

    status:  pending | approved | rejected | disabled
    role:    user | admin
"""

from __future__ import annotations

from models import get_db, now

SCHEMA = """
CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY,
    email TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL DEFAULT '',
    picture TEXT NOT NULL DEFAULT '',
    google_sub TEXT NOT NULL DEFAULT '',
    role TEXT NOT NULL DEFAULT 'user',
    status TEXT NOT NULL DEFAULT 'pending',
    created_at TEXT NOT NULL,
    approved_at TEXT NOT NULL DEFAULT '',
    approved_by TEXT NOT NULL DEFAULT '',
    last_login TEXT NOT NULL DEFAULT ''
);
"""

STATUSES = ("pending", "approved", "rejected", "disabled")
ROLES = ("user", "admin")

_ROW = ("id", "email", "name", "picture", "google_sub", "role", "status",
        "created_at", "approved_at", "approved_by", "last_login")


def _row_to_user(row) -> dict | None:
    return dict(row) if row else None


def by_id(user_id) -> dict | None:
    return _row_to_user(get_db().execute("SELECT * FROM users WHERE id=?", (user_id,)).fetchone())


def by_email(email: str) -> dict | None:
    return _row_to_user(get_db().execute("SELECT * FROM users WHERE email=?",
                                        (str(email or "").strip().lower(),)).fetchone())


def is_admin_email(email: str, admin_emails=None) -> bool:
    if admin_emails is None:
        from flask import current_app
        admin_emails = current_app.config.get("ADMIN_EMAILS") or []
    return str(email or "").strip().lower() in [str(e).lower() for e in admin_emails]


def upsert_from_claims(claims: dict) -> dict:
    """Create or refresh the profile for a verified Google identity.

    ``claims`` needs at least ``email``; ``sub``, ``name`` and ``picture`` are kept
    when present.  An existing profile keeps its role and status - re-signing in
    never resets an admin's decision.  Emails on the ``ADMIN_EMAILS`` bootstrap
    list are always promoted to admin and auto-approved so the console can never
    be locked out.
    """
    email = str(claims.get("email") or "").strip().lower()
    if not email:
        raise ValueError("Google account has no e-mail address.")
    sub = str(claims.get("sub") or "")
    name = str(claims.get("name") or "")[:120]
    picture = str(claims.get("picture") or "")[:500]
    ts, db = now(), get_db()
    existing = by_email(email)
    if existing:
        fields, vals = ["last_login=?"], [ts]
        if sub and not existing["google_sub"]:
            fields.append("google_sub=?"); vals.append(sub)
        if name and name != existing["name"]:
            fields.append("name=?"); vals.append(name)
        if picture and picture != existing["picture"]:
            fields.append("picture=?"); vals.append(picture)
        if is_admin_email(email) and (existing["role"] != "admin" or existing["status"] != "approved"):
            fields += ["role=?", "status=?", "approved_at=?", "approved_by=?"]
            vals += ["admin", "approved", existing["approved_at"] or ts, "admin-emails"]
        vals.append(existing["id"])
        with db:
            db.execute(f"UPDATE users SET {', '.join(fields)} WHERE id=?", vals)
        return by_id(existing["id"])
    admin = is_admin_email(email)
    with db:
        db.execute(
            "INSERT INTO users (email,name,picture,google_sub,role,status,created_at,"
            "approved_at,approved_by,last_login) VALUES (?,?,?,?,?,?,?,?,?,?)",
            (email, name, picture, sub,
             "admin" if admin else "user",
             "approved" if admin else "pending",
             ts, ts if admin else "", "admin-emails" if admin else "", ts))
    return by_email(email)


def create_dev_user(email: str, name: str = "", role: str = "") -> dict:
    """DEV_LOGIN shortcut: the same profile rules without a Google round-trip.

    Only reachable when ``DEV_LOGIN`` is on and the app is not in production.
    ``role='admin'`` is honoured (handy for demos) but still needs the caller to
    have enabled DEV_LOGIN explicitly.
    """
    email = str(email or "").strip().lower()
    if not email or "@" not in email:
        raise ValueError("Use a real e-mail address.")
    claims = {"email": email, "name": name or email.split("@")[0], "sub": "dev:" + email}
    user = upsert_from_claims(claims)
    if role == "admin" and user["role"] != "admin":
        with get_db() as db:
            db.execute("UPDATE users SET role='admin', status='approved', approved_at=?, "
                       "approved_by='dev' WHERE id=?", (now(), user["id"]))
        user = by_id(user["id"])
    return user


def set_status(user_id: int, status: str, approved_by: str = "") -> dict | None:
    """Admin decision: pending -> approved / rejected; also disable / re-enable."""
    if status not in STATUSES:
        raise ValueError("unknown status")
    ts, db = now(), get_db()
    approved_at, by = "", ""
    if status == "approved":
        approved_at, by = ts, approved_by or "admin"
    with db:
        db.execute("UPDATE users SET status=?, approved_at=?, approved_by=? WHERE id=?",
                   (status, approved_at, by, user_id))
    return by_id(user_id)


def set_role(user_id: int, role: str) -> dict | None:
    if role not in ROLES:
        raise ValueError("unknown role")
    with get_db() as db:
        db.execute("UPDATE users SET role=? WHERE id=?", (role, user_id))
    return by_id(user_id)


def count_admins() -> int:
    return get_db().execute("SELECT COUNT(*) FROM users WHERE role='admin' AND status='approved'").fetchone()[0]


def list_users() -> list[dict]:
    """All profiles newest-pending first, each with how much work they have."""
    rows = get_db().execute(
        "SELECT u.*, "
        "(SELECT COUNT(*) FROM studies s WHERE s.owner_id=u.id) AS projects, "
        "(SELECT COUNT(*) FROM respondents r JOIN studies s ON r.study_id=s.id "
        " WHERE s.owner_id=u.id AND r.status='complete') AS completes "
        "FROM users u ORDER BY "
        "CASE u.status WHEN 'pending' THEN 0 ELSE 1 END, u.created_at DESC").fetchall()
    return [dict(r) for r in rows]


def projects_of(user_id: int) -> list[dict]:
    rows = get_db().execute(
        "SELECT s.slug, s.title, s.status, s.updated_at, "
        "(SELECT COUNT(*) FROM respondents r WHERE r.study_id=s.id AND r.status='complete') AS completes "
        "FROM studies s WHERE s.owner_id=? ORDER BY s.updated_at DESC", (user_id,)).fetchall()
    return [dict(r) for r in rows]
