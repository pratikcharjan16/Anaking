"""
Platform accounts — SurveyKart profiles, protected Admin account, and Kart points.

Supports:
  1. Protected Master Admin credentials configured with ``ADMIN_USERNAME`` and
     ``ADMIN_PASSWORD`` (password sign-in is disabled when the password is unset)
  2. Direct SurveyKart registration & sign-in (Name, Email/Username, Password) —
     automatically allocates 100 Kart points upon registration
  3. Google OAuth sign-in & registration — one profile per e-mail. A brand-new
     Google account (whether they clicked "Sign in" or "Register") is created as
     ``pending`` with an empty Kart and becomes an approval request for the admin;
     the one-time 100 Kart point welcome allocation is added at the exact moment
     the admin approves (see :func:`set_status` / :func:`approve_user`).

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

# Every welcome-allocation ledger row starts with this prefix (legacy rows from
# "…on SurveyKart registration" included). Its presence is what makes the 100 pt
# welcome grant exactly-once: approval grants only when no such row exists yet.
WELCOME_REASON_PREFIX = "Welcome allocation"


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


def auth_source(user: dict | None) -> str:
    """How this account was created: ``google`` | ``password`` | ``dev`` | ``surveykart``."""
    if not user:
        return "surveykart"
    sub = str(user.get("google_sub") or "")
    if sub.startswith("dev:"):
        return "dev"
    if sub:
        return "google"
    if user.get("password_hash"):
        return "password"
    return "surveykart"


def _has_welcome_tx(db, user_id) -> bool:
    if not user_id:
        return False
    return db.execute(
        "SELECT 1 FROM point_transactions WHERE user_id=? AND reason LIKE ? LIMIT 1",
        (int(user_id), WELCOME_REASON_PREFIX + "%"),
    ).fetchone() is not None


def has_welcome_allocation(user_id) -> bool:
    """True once the one-time welcome Kart allocation is on the ledger for this user."""
    return _has_welcome_tx(get_db(), user_id)


def welcome_points_pending(user: dict | None) -> int:
    """Kart points a pending (not-yet-approved) account will receive on approval.

    100 for a regular pending account still awaiting its welcome allocation,
    0 for admins, approved users, and accounts that already received it."""
    if not user or user.get("role") == "admin" or user.get("status") != "pending":
        return 0
    return 0 if has_welcome_allocation(user["id"]) else DEFAULT_POINTS


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


def is_master_admin_identifier(identifier: str) -> bool:
    """True when ``identifier`` names the protected master admin account."""
    return str(identifier or "").strip().lower() in (
        MASTER_ADMIN_USERNAME.lower(), MASTER_ADMIN_EMAIL)


def master_admin_password_configured() -> bool:
    """True when an ``ADMIN_PASSWORD`` was set for the master admin account.

    While it is empty, master-admin *password* sign-in is disabled by design
    (the stored hash is of an unknown random value) — the separate Admin
    Login surfaces this state so the owner isn't stuck guessing passwords."""
    return bool(Config.ADMIN_PASSWORD)


def authenticate_admin(identifier: str, password: str) -> dict | None:
    """Like :func:`authenticate_credentials`, but only platform admins pass:
    the protected master admin, or any approved account with the admin role
    signing in with its own password. Regular users never authenticate here."""
    user = authenticate_credentials(identifier, password)
    if user and user.get("role") == "admin" and user.get("status") == "approved":
        return user
    return None


def upsert_from_claims(claims: dict) -> dict:
    """Create or refresh the profile for a verified Google identity.

    A brand-new regular account starts ``pending`` with an *empty* Kart
    (``points_limit=0``): it is an approval request for the admin, and the
    100 Kart point welcome allocation is added by :func:`set_status` at the
    moment of approval.  ``ADMIN_EMAILS`` accounts are approved admins with
    an unlimited Kart straight away, so the console can never be locked out."""
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
            fields += ["role=?", "status=?", "approved_at=?", "approved_by=?", "points_limit=?"]
            vals += ["admin", "approved", existing["approved_at"] or ts, "admin-emails",
                     ADMIN_UNLIMITED_POINTS]
        vals.append(existing["id"])
        with db:
            db.execute(f"UPDATE users SET {', '.join(fields)} WHERE id=?", vals)
        return by_id(existing["id"])
    admin = is_admin_email(email)
    # Pending accounts hold an empty Kart until approval (welcome_points_pending()
    # advertises the 100 pts that land on approval); admins are unlimited.
    pts = ADMIN_UNLIMITED_POINTS if admin else 0
    with db:
        db.execute(
            "INSERT INTO users (email,username,password_hash,name,picture,google_sub,role,status,"
            "points_limit,created_at,approved_at,approved_by,last_login) "
            "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (email, "", "", name, picture, sub,
             "admin" if admin else "user",
             "approved" if admin else "pending",
             pts, ts, ts if admin else "", "admin-emails" if admin else "", ts))
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


def set_status(user_id: int, status: str, approved_by: str = "",
               welcome_points: int | None = None) -> dict | None:
    """Admin decision: pending -> approved / rejected; also disable / re-enable.

    Approving (or re-enabling) a regular account also lands its one-time
    welcome allocation in the Kart — 100 pts by default, or ``welcome_points``
    when the admin chooses a different amount while approving.  The grant is
    exactly-once: it only happens when no ``Welcome allocation…`` ledger row
    exists yet, tops the Kart limit up to the granted amount, and is skipped
    for admins (unlimited) and for accounts that already received it (incl.
    legacy pending accounts credited at signup under the old rules).  The
    returned profile carries ``welcome_points_granted`` (pts actually added).
    """
    if status not in STATUSES:
        raise ValueError("unknown status")
    target = by_id(user_id)
    if target and is_protected_admin(target) and status != "approved":
        raise ValueError("The master admin account Anaking.admin is protected and cannot be disabled.")
    if welcome_points is not None:
        try:
            welcome_points = max(0, min(100_000, int(welcome_points)))
        except (TypeError, ValueError):
            raise ValueError("welcome points must be a number")
    ts, db = now(), get_db()
    approved_at, by = "", ""
    if status == "approved":
        approved_at, by = ts, approved_by or "admin"
    granted = 0
    with db:
        db.execute("UPDATE users SET status=?, approved_at=?, approved_by=? WHERE id=?",
                   (status, approved_at, by, user_id))
        if status == "approved":
            row = db.execute("SELECT role, points_limit FROM users WHERE id=?",
                             (user_id,)).fetchone()
            if row and row["role"] != "admin" and not _has_welcome_tx(db, user_id):
                pts = DEFAULT_POINTS if welcome_points is None else welcome_points
                cur_limit = int(row["points_limit"] or 0)
                new_limit = max(cur_limit, pts)
                granted = new_limit - cur_limit
                db.execute("UPDATE users SET points_limit=? WHERE id=?", (new_limit, user_id))
                db.execute(
                    "INSERT INTO point_transactions (user_id, delta, balance_after, reason, actor, created_at) "
                    "VALUES (?,?,?,?,?,?)",
                    (int(user_id), granted, new_limit,
                     f"Welcome allocation on admin approval ({pts} pts)",
                     str(approved_by or "admin")[:120], ts),
                )
    user = by_id(user_id)
    if user is not None:
        user["welcome_points_granted"] = granted
    return user


def approve_user(user_id: int, approved_by: str = "admin",
                 welcome_points: int | None = None) -> dict | None:
    """Approve an account and add its welcome Kart points (100 by default), once."""
    return set_status(user_id, "approved", approved_by=approved_by,
                      welcome_points=welcome_points)


# --------------------------------------------------------------------- admin/user e-mail nudges
def _admin_notification_emails() -> list[str]:
    try:
        from flask import current_app
        emails = current_app.config.get("ADMIN_EMAILS") or []
    except RuntimeError:
        emails = Config.ADMIN_EMAILS
    return [str(e).strip().lower() for e in emails if str(e).strip()]


def notify_admins_pending_signup(user: dict | None) -> bool:
    """Best-effort e-mail to ``ADMIN_EMAILS``: a new account awaits approval.

    Only sends when SMTP is configured (see core.mailer); never raises, so a
    mail problem can never break a Google sign-in.  Returns True if sent."""
    try:
        if not user or user.get("status") != "pending":
            return False
        from core import mailer
        if not mailer.smtp_settings():
            return False
        recipients = _admin_notification_emails()
        if not recipients:
            return False
        name = str(user.get("name") or user.get("email") or "A new user")
        source = auth_source(user)
        source_label = {"google": "Google", "dev": "dev sign-in"}.get(source, "SurveyKart")
        subject = f"SurveyKart approval request: {name} ({user.get('email')})"
        body = (
            f"{name} <{user.get('email')}> just signed in with {source_label} and is "
            f"waiting for your approval on SurveyKart.\n\n"
            f"Approve (or reject) them in the Admin Console — under "
            f"\"Accounts waiting for approval\". Their {DEFAULT_POINTS} Kart points "
            f"welcome allocation is added to their Kart automatically the moment "
            f"you approve (you can adjust the amount while approving).\n\n"
            f"Requested: {user.get('created_at') or ''}\n"
            f"Admin Console: /admin/console\n"
        )
        for to in recipients:
            mailer.send_mail(to, subject, body)
        return True
    except Exception:                                          # noqa: BLE001 - best-effort only
        return False


def notify_user_approved(user: dict | None, granted_points: int = 0) -> bool:
    """Best-effort e-mail to the user: approved, welcome points are in the Kart."""
    try:
        if not user or user.get("status") != "approved" or not user.get("email"):
            return False
        from core import mailer
        if not mailer.smtp_settings():
            return False
        name = str(user.get("name") or "there")
        pts = int(granted_points or 0)
        kart_line = (f"{pts} Kart points have been added to your Kart" if pts
                     else "Your Kart points are ready in your Kart")
        body = (
            f"Hi {name},\n\n"
            f"Great news — your SurveyKart account has been approved! "
            f"{kart_line}, so you can start building your first study right away.\n\n"
            f"Sign in any time with the same Google account: /signin\n"
        )
        mailer.send_mail(str(user["email"]), "You're approved on SurveyKart 🎉", body)
        return True
    except Exception:                                          # noqa: BLE001 - best-effort only
        return False


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
    welcomed_ids = {
        r[0] for r in get_db().execute(
            "SELECT DISTINCT user_id FROM point_transactions WHERE reason LIKE ?",
            (WELCOME_REASON_PREFIX + "%",)).fetchall()
    }
    out = []
    for r in rows:
        d = _enrich_user(r)
        d["auth_source"] = auth_source(d)
        d.pop("password_hash", None)
        used = user_points_usage(d["id"])
        limit = int(d.get("points_limit") if d.get("points_limit") is not None else DEFAULT_POINTS)
        d["points_limit"] = limit
        d["points_used"] = used
        d["points_balance"] = ADMIN_UNLIMITED_POINTS if d["role"] == "admin" else max(0, limit - used)
        d["welcome_points_granted"] = d["id"] in welcomed_ids
        d["welcome_points_pending"] = (
            DEFAULT_POINTS
            if (d["status"] == "pending" and d["role"] != "admin" and d["id"] not in welcomed_ids)
            else 0
        )
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
