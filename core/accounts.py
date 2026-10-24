"""
Platform accounts — SurveyKart profiles, protected Admin account, and Kart points.

Supports:
  1. Protected Master Admin credentials configured with ``ADMIN_USERNAME`` and
     ``ADMIN_PASSWORD`` (password sign-in is disabled when the password is unset)
  2. Direct SurveyKart registration & sign-in (Name, Email/Username, Password) —
     automatically allocates 100 Kart points upon registration
  3. Google OAuth sign-in & registration — one profile per e-mail, also starts with
     100 Kart points

    status:  pending | approved | rejected | disabled
    role:    user | admin
"""

from __future__ import annotations

import secrets
from werkzeug.security import check_password_hash, generate_password_hash

from config import Config
from models import get_db, now

MASTER_ADMIN_USERNAME = Config.ADMIN_USERNAME
MASTER_ADMIN_EMAIL = "anaking.admin@surveykart.local"
DEFAULT_POINTS = 100
ADMIN_UNLIMITED_POINTS = 999999

# Keep only a hash in the application and database. An unset password becomes an
# unknown random value, disabling master-admin password sign-in until configured.
_MASTER_ADMIN_HASH = generate_password_hash(
    Config.ADMIN_PASSWORD or secrets.token_urlsafe(32), method="pbkdf2:sha256:260000"
)
_DUMMY_HASH = generate_password_hash("surveykart-dummy-verification-secret", method="pbkdf2:sha256:260000")

SCHEMA = """
CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY,
    email TEXT UNIQUE NOT NULL,
    username TEXT NOT NULL DEFAULT '',
    password_hash TEXT NOT NULL DEFAULT '',
    name TEXT NOT NULL DEFAULT '',
    picture TEXT NOT NULL DEFAULT '',
    google_sub TEXT NOT NULL DEFAULT '',
    role TEXT NOT NULL DEFAULT 'user',
    status TEXT NOT NULL DEFAULT 'pending',
    points_limit INTEGER NOT NULL DEFAULT 100,
    created_at TEXT NOT NULL,
    approved_at TEXT NOT NULL DEFAULT '',
    approved_by TEXT NOT NULL DEFAULT '',
    last_login TEXT NOT NULL DEFAULT ''
);
"""

STATUSES = ("pending", "approved", "rejected", "disabled")
ROLES = ("user", "admin")


def _enrich_user(row) -> dict | None:
    if not row:
        return None
    u = dict(row)
    u.setdefault("username", "")
    u.setdefault("points_limit", DEFAULT_POINTS)
    u["is_protected"] = is_protected_admin(u)
    return u


def is_protected_admin(user: dict | None) -> bool:
    if not user:
        return False
    uname = str(user.get("username") or "").strip().lower()
    email = str(user.get("email") or "").strip().lower()
    return uname == MASTER_ADMIN_USERNAME.lower() or email == MASTER_ADMIN_EMAIL.lower()


def by_id(user_id) -> dict | None:
    if not user_id:
        return None
    return _enrich_user(get_db().execute("SELECT * FROM users WHERE id=?", (user_id,)).fetchone())


def by_email(email: str) -> dict | None:
    return _enrich_user(
        get_db().execute("SELECT * FROM users WHERE email=?", (str(email or "").strip().lower(),)).fetchone()
    )


def by_username(username: str) -> dict | None:
    clean = str(username or "").strip().lower()
    if not clean:
        return None
    return _enrich_user(
        get_db().execute("SELECT * FROM users WHERE LOWER(username)=?", (clean,)).fetchone()
    )


def ensure_master_admin(conn=None) -> dict | None:
    """Ensure the protected ``Anaking.admin`` account exists in ``users``."""
    db = conn or get_db()
    ts = now()
    existing = db.execute(
        "SELECT * FROM users WHERE LOWER(username)=? OR email=?",
        (MASTER_ADMIN_USERNAME.lower(), MASTER_ADMIN_EMAIL),
    ).fetchone()
    if existing:
        with db:
            db.execute(
                "UPDATE users SET username=?, role='admin', status='approved', "
                "password_hash=?, points_limit=? WHERE id=?",
                (MASTER_ADMIN_USERNAME, _MASTER_ADMIN_HASH, ADMIN_UNLIMITED_POINTS, existing["id"]),
            )
        if conn is not None:
            return dict(db.execute("SELECT * FROM users WHERE id=?", (existing["id"],)).fetchone())
        return by_id(existing["id"])
    with db:
        db.execute(
            "INSERT INTO users (email, username, password_hash, name, picture, google_sub, "
            "role, status, points_limit, created_at, approved_at, approved_by, last_login) "
            "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (
                MASTER_ADMIN_EMAIL,
                MASTER_ADMIN_USERNAME,
                _MASTER_ADMIN_HASH,
                "SurveyKart Admin",
                "",
                "",
                "admin",
                "approved",
                ADMIN_UNLIMITED_POINTS,
                ts,
                ts,
                "system-bootstrap",
                ts,
            ),
        )
    if conn is not None:
        row = db.execute("SELECT * FROM users WHERE email=?", (MASTER_ADMIN_EMAIL,)).fetchone()
        return dict(row) if row else None
    return by_email(MASTER_ADMIN_EMAIL)


def is_admin_email(email: str, admin_emails=None) -> bool:
    if admin_emails is None:
        from flask import current_app
        admin_emails = current_app.config.get("ADMIN_EMAILS") or []
    clean = str(email or "").strip().lower()
    if clean == MASTER_ADMIN_EMAIL:
        return True
    return clean in [str(e).lower() for e in admin_emails]


def register_credentials(name: str, email: str, password: str, username: str = "") -> dict:
    """Register a new SurveyKart user with 100 initial Kart points."""
    clean_email = str(email or "").strip().lower()
    clean_user = str(username or "").strip()
    clean_name = str(name or "").strip()[:120] or (clean_user or clean_email.split("@")[0])
    if not clean_email or "@" not in clean_email or "." not in clean_email.split("@")[-1]:
        raise ValueError("Enter a valid e-mail address.")
    if len(password or "") < 6:
        raise ValueError("Choose a password of at least 6 characters.")
    if clean_email == MASTER_ADMIN_EMAIL or clean_user.lower() == MASTER_ADMIN_USERNAME.lower():
        raise ValueError("That username is reserved for the platform administrator.")
    if by_email(clean_email):
        raise ValueError("An account with this e-mail already exists. Sign in instead.")
    if clean_user and by_username(clean_user):
        raise ValueError("That username is already taken. Choose another username.")

    pw_hash = generate_password_hash(password, method="pbkdf2:sha256:260000")
    admin = is_admin_email(clean_email)
    pts = ADMIN_UNLIMITED_POINTS if admin else DEFAULT_POINTS
    ts, db = now(), get_db()
    with db:
        cur = db.execute(
            "INSERT INTO users (email, username, password_hash, name, picture, google_sub, "
            "role, status, points_limit, created_at, approved_at, approved_by, last_login) "
            "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (
                clean_email,
                clean_user,
                pw_hash,
                clean_name,
                "",
                "",
                "admin" if admin else "user",
                "approved",
                pts,
                ts,
                ts,
                "surveykart-signup",
                ts,
            ),
        )
        uid = cur.lastrowid
        db.execute(
            "INSERT INTO point_transactions (user_id, delta, balance_after, reason, actor, created_at) "
            "VALUES (?,?,?,?,?,?)",
            (uid, DEFAULT_POINTS, pts, "Welcome allocation on SurveyKart registration (100 pts)", "system", ts),
        )
    return by_id(uid)


def authenticate_credentials(identifier: str, password: str) -> dict | None:
    """Verify username or e-mail + password, including the configured protected admin."""
    ident = str(identifier or "").strip()
    pw = str(password or "")
    if not ident or not pw:
        return None

    # Protected Master Admin check using the environment-configured password hash.
    if ident.lower() in (MASTER_ADMIN_USERNAME.lower(), MASTER_ADMIN_EMAIL):
        if check_password_hash(_MASTER_ADMIN_HASH, pw):
            admin_user = ensure_master_admin()
            with get_db() as db:
                db.execute("UPDATE users SET last_login=? WHERE id=?", (now(), admin_user["id"]))
            return by_id(admin_user["id"])
        return None

    db = get_db()
    row = db.execute(
        "SELECT * FROM users WHERE email=? OR (username != '' AND LOWER(username)=?)",
        (ident.lower(), ident.lower()),
    ).fetchone()
    pw_hash = row["password_hash"] if (row and row["password_hash"]) else _DUMMY_HASH
    valid = check_password_hash(pw_hash, pw)
    if not row or not row["password_hash"] or not valid:
        return None
    with db:
        db.execute("UPDATE users SET last_login=? WHERE id=?", (now(), row["id"]))
    return by_id(row["id"])


def upsert_from_claims(claims: dict) -> dict:
    """Create or refresh the profile for a verified Google identity (allocating 100 Kart pts on signup)."""
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
    pts = ADMIN_UNLIMITED_POINTS if admin else DEFAULT_POINTS
    with db:
        cur = db.execute(
            "INSERT INTO users (email,username,password_hash,name,picture,google_sub,role,status,"
            "points_limit,created_at,approved_at,approved_by,last_login) "
            "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (email, "", "", name, picture, sub,
             "admin" if admin else "user",
             "approved" if admin else "pending",
             pts, ts, ts if admin else "", "admin-emails" if admin else "", ts))
        uid = cur.lastrowid
        db.execute(
            "INSERT INTO point_transactions (user_id, delta, balance_after, reason, actor, created_at) "
            "VALUES (?,?,?,?,?,?)",
            (uid, DEFAULT_POINTS, pts, "Welcome allocation on SurveyKart registration (100 pts)", "system", ts),
        )
    return by_email(email)


def create_dev_user(email: str, name: str = "", role: str = "") -> dict:
    """DEV_LOGIN shortcut: the same profile rules without a Google round-trip."""
    email = str(email or "").strip().lower()
    if not email or "@" not in email:
        raise ValueError("Use a real e-mail address.")
    claims = {"email": email, "name": name or email.split("@")[0], "sub": "dev:" + email}
    user = upsert_from_claims(claims)
    if role == "admin" and user["role"] != "admin":
        with get_db() as db:
            db.execute("UPDATE users SET role='admin', status='approved', points_limit=?, approved_at=?, "
                       "approved_by='dev' WHERE id=?", (ADMIN_UNLIMITED_POINTS, now(), user["id"]))
        user = by_id(user["id"])
    return user


def set_status(user_id: int, status: str, approved_by: str = "") -> dict | None:
    """Admin decision: pending -> approved / rejected; also disable / re-enable."""
    if status not in STATUSES:
        raise ValueError("unknown status")
    target = by_id(user_id)
    if target and is_protected_admin(target) and status != "approved":
        raise ValueError("The master admin account Anaking.admin is protected and cannot be disabled.")
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
    target = by_id(user_id)
    if target and is_protected_admin(target) and role != "admin":
        raise ValueError("The master admin account Anaking.admin is protected and cannot be demoted.")
    with get_db() as db:
        db.execute("UPDATE users SET role=? WHERE id=?", (role, user_id))
    return by_id(user_id)


def adjust_points(user_id: int, delta: int | None = None, new_limit: int | None = None,
                  reason: str = "", actor: str = "admin") -> dict | None:
    """Admin increases, decreases, or sets the exact Kart point limit for a user."""
    target = by_id(user_id)
    if not target:
        return None
    cur_limit = int(target.get("points_limit") if target.get("points_limit") is not None else DEFAULT_POINTS)
    if new_limit is not None:
        updated_limit = max(0, min(10_000_000, int(new_limit)))
        diff = updated_limit - cur_limit
    else:
        diff = int(delta or 0)
        updated_limit = max(0, min(10_000_000, cur_limit + diff))
        diff = updated_limit - cur_limit
    ts, db = now(), get_db()
    with db:
        db.execute("UPDATE users SET points_limit=? WHERE id=?", (updated_limit, int(user_id)))
        db.execute(
            "INSERT INTO point_transactions (user_id, delta, balance_after, reason, actor, created_at) "
            "VALUES (?,?,?,?,?,?)",
            (int(user_id), diff, updated_limit,
             str(reason or ("Admin adjusted Kart limit" if diff >= 0 else "Admin reduced Kart limit"))[:300],
             str(actor or "admin")[:120], ts),
        )
    return by_id(user_id)


def count_admins() -> int:
    return get_db().execute("SELECT COUNT(*) FROM users WHERE role='admin' AND status='approved'").fetchone()[0]


def list_users() -> list[dict]:
    """All profiles newest-pending first, with project counts and Kart point balances."""
    from core.kart import user_points_usage
    rows = get_db().execute(
        "SELECT u.*, "
        "(SELECT COUNT(*) FROM studies s WHERE s.owner_id=u.id) AS projects, "
        "(SELECT COUNT(*) FROM respondents r JOIN studies s ON r.study_id=s.id "
        " WHERE s.owner_id=u.id AND r.status='complete') AS completes "
        "FROM users u ORDER BY "
        "CASE u.status WHEN 'pending' THEN 0 ELSE 1 END, u.created_at DESC").fetchall()
    out = []
    for r in rows:
        d = _enrich_user(r)
        d.pop("password_hash", None)
        used = user_points_usage(d["id"])
        limit = int(d.get("points_limit") if d.get("points_limit") is not None else DEFAULT_POINTS)
        d["points_limit"] = limit
        d["points_used"] = used
        d["points_balance"] = ADMIN_UNLIMITED_POINTS if d["role"] == "admin" else max(0, limit - used)
        out.append(d)
    return out


def projects_of(user_id: int) -> list[dict]:
    from core.kart import study_points
    import json
    rows = get_db().execute(
        "SELECT s.slug, s.title, s.status, s.updated_at, s.cfg, "
        "(SELECT COUNT(*) FROM respondents r WHERE r.study_id=s.id AND r.status='complete') AS completes "
        "FROM studies s WHERE s.owner_id=? ORDER BY s.updated_at DESC", (user_id,)).fetchall()
    out = []
    for r in rows:
        d = dict(r)
        cfg = json.loads(d.pop("cfg", "") or "{}")
        d["points_used"] = study_points(cfg)
        out.append(d)
    return out
