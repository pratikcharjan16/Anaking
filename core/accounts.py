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

import re
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

# The users table is created by :mod:`core.userdata` in the users database.
SCHEMA = ""

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
    """Register a SurveyKart account — an *approval request* until the admin grants access.

    Same rule as Google sign-in, so the two front doors behave identically:

    * a regular account is created ``pending`` with an empty Kart; the admin sees
      it in the approval queue and approving it lands the one-time 100 Kart point
      welcome allocation in the same click (:func:`set_status`);
    * an address listed in ``ADMIN_EMAILS`` is the documented bootstrap, so it is
      created approved with the unlimited admin Kart — otherwise the very first
      admin could never get in.
    """
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
    status = "approved" if admin else "pending"
    pts = ADMIN_UNLIMITED_POINTS if admin else 0
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
                status,
                pts,
                ts,
                ts if admin else "",
                "surveykart-signup" if admin else "",
                ts,
            ),
        )
        uid = cur.lastrowid
        if admin:
            # Bootstrap admin: the Kart is unlimited and the allocation is recorded
            # so approval-style top-ups can never double-grant.
            db.execute(
                "INSERT INTO point_transactions (user_id, delta, balance_after, reason, actor, created_at) "
                "VALUES (?,?,?,?,?,?)",
                (uid, ADMIN_UNLIMITED_POINTS, pts,
                 "Admin account — unlimited Kart (ADMIN_EMAILS bootstrap)", "system", ts),
            )
    return by_id(uid)


def has_password(user: dict | None) -> bool:
    """True when the account can sign in with a SurveyKart password."""
    return bool(user and str(user.get("password_hash") or ""))


def set_password(user_id: int, password: str) -> dict | None:
    """Set a new password (used by the recovery flow). Signs out other sessions by design."""
    clean = str(password or "")
    if len(clean) < 8:
        raise ValueError("Choose a password of at least 8 characters.")
    target = by_id(user_id)
    if not target:
        raise ValueError("Unknown account.")
    pw_hash = generate_password_hash(clean, method="pbkdf2:sha256:260000")
    with get_db() as db:
        db.execute("UPDATE users SET password_hash=? WHERE id=?", (pw_hash, int(user_id)))
    return by_id(user_id)


def signin_identity(user: dict | None) -> dict:
    """What an account signs in with — drives the recovery page's wording."""
    if not user:
        return {}
    source = auth_source(user)
    return {
        "email": user.get("email") or "",
        "username": user.get("username") or "",
        "auth_source": source,
        "has_password": has_password(user),
        "google": source in ("google", "dev"),
    }


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


# ====================================================================================
# ADMIN ACCOUNT DESK
# ====================================================================================
# One account, in every context: identity, access, Kart ledger, projects and the
# audit trail. The Admin Console renders this as a master/detail "desk"; the helpers
# below keep the SQL (and the safety rules) out of the route module.

EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")
USERNAME_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{1,39}$")


def _clean_identity(name=None, email=None, username=None) -> dict:
    """Validate the editable identity fields; only the supplied ones are returned."""
    out = {}
    if name is not None:
        clean_name = str(name).strip()[:120]
        if not clean_name:
            raise ValueError("A display name is required.")
        out["name"] = clean_name
    if email is not None:
        clean_email = str(email).strip().lower()
        if not EMAIL_RE.match(clean_email):
            raise ValueError("Enter a valid e-mail address.")
        out["email"] = clean_email
    if username is not None:
        clean_username = str(username).strip()
        if clean_username and not USERNAME_RE.match(clean_username):
            raise ValueError("Usernames use 2-40 letters, numbers, dots, dashes or underscores.")
        out["username"] = clean_username
    return out


def update_profile(user_id: int, name=None, email=None, username=None) -> dict | None:
    """Admin edit of a profile's display name, e-mail or username.

    The protected master admin's sign-in identity (e-mail + username) is immutable by
    design - only its display name may change. Uniqueness is checked the same way
    registration checks it, so the admin can never create a duplicate identity.
    """
    target = by_id(user_id)
    if not target:
        raise ValueError("Unknown account.")
    clean = _clean_identity(name=name, email=email, username=username)
    if not clean:
        raise ValueError("Nothing to update.")
    protected = is_protected_admin(target)
    if protected and ("email" in clean or "username" in clean):
        changed_email = clean.get("email", target["email"]) != target["email"]
        changed_user = clean.get("username", target.get("username") or "") != (target.get("username") or "")
        if changed_email or changed_user:
            raise ValueError("The master admin's sign-in identity is protected and cannot be changed.")

    if "email" in clean:
        if clean["email"] == MASTER_ADMIN_EMAIL and not protected:
            raise ValueError("That e-mail is reserved for the platform administrator.")
        other = by_email(clean["email"])
        if other and other["id"] != target["id"]:
            raise ValueError("Another account already uses this e-mail address.")
    if "username" in clean and clean["username"]:
        if clean["username"].lower() == MASTER_ADMIN_USERNAME.lower() and not protected:
            raise ValueError("That username is reserved for the platform administrator.")
        other = by_username(clean["username"])
        if other and other["id"] != target["id"]:
            raise ValueError("That username is already taken.")

    fields = list(clean.keys())
    values = [clean[f] for f in fields]
    with get_db() as db:
        db.execute(f"UPDATE users SET {', '.join(f'{f}=?' for f in fields)} WHERE id=?",
                   (*values, target["id"]))
    return by_id(target["id"])


def delete_user(user_id: int) -> dict:
    """Delete an account that no longer owns anything.

    Projects are never destroyed implicitly: the admin must transfer or delete them
    first, which keeps a delete from taking a whole study (and its responses) with it.
    """
    target = by_id(user_id)
    if not target:
        raise ValueError("Unknown account.")
    if is_protected_admin(target):
        raise ValueError("The master admin account Anaking.admin cannot be deleted.")
    db = get_db()
    if target["role"] == "admin" and count_admins() <= 1:
        raise ValueError("The last admin cannot be deleted.")
    owned = db.execute("SELECT COUNT(*) FROM studies WHERE owner_id=?", (target["id"],)).fetchone()[0]
    if owned:
        raise ValueError(
            f"This account still owns {owned} project{'s' if owned != 1 else ''}. "
            "Transfer or delete them first."
        )
    teams = [r[0] for r in db.execute(
        "SELECT id FROM workspace_teams WHERE creator_id=?", (target["id"],)).fetchall()]
    with db:
        # Team spaces this account created go with it; the studies inside them are
        # already transferred or deleted, so no research data is lost.
        for team_id in teams:
            db.execute("DELETE FROM team_projects WHERE team_id=?", (team_id,))
            db.execute("DELETE FROM team_members WHERE team_id=?", (team_id,))
            db.execute("DELETE FROM workspace_teams WHERE id=?", (team_id,))
        # The change log is history, not state: it keeps the account's denormalised
        # name/e-mail so the record of what happened stays readable after a delete.
        for table, column in (("point_transactions", "user_id"), ("point_requests", "user_id"),
                              ("team_members", "user_id"), ("study_shares", "shared_with_user_id")):
            db.execute(f"DELETE FROM {table} WHERE {column}=?", (target["id"],))
        db.execute("DELETE FROM users WHERE id=?", (target["id"],))
    return {"id": target["id"], "email": target["email"], "teams_removed": len(teams)}


def account_detail(user_id: int) -> dict | None:
    """A single account in full context: profile, projects, Kart ledger and audit trail."""
    from core.kart import user_points_usage
    user = by_id(user_id)
    if not user:
        return None
    signin = signin_identity(user)      # before the hash is stripped from the payload
    user.pop("password_hash", None)
    user["auth_source"] = auth_source(user)
    db = get_db()
    limit = int(user.get("points_limit") if user.get("points_limit") is not None else DEFAULT_POINTS)
    used = user_points_usage(user["id"])
    user["points_limit"] = limit
    user["points_used"] = used
    user["points_balance"] = (ADMIN_UNLIMITED_POINTS if user["role"] == "admin"
                              else max(0, limit - used))
    user["welcome_points_pending"] = welcome_points_pending(user)
    user["welcome_points_granted"] = has_welcome_allocation(user["id"])

    ledger = [dict(r) for r in db.execute(
        "SELECT id, delta, balance_after, reason, actor, created_at FROM point_transactions "
        "WHERE user_id=? ORDER BY id DESC LIMIT 40", (user["id"],)).fetchall()]
    requests = [dict(r) for r in db.execute(
        "SELECT id, requested_points, reason, status, reviewed_by, reviewed_at, created_at "
        "FROM point_requests WHERE user_id=? ORDER BY id DESC LIMIT 20", (user["id"],)).fetchall()]
    # The account's own actions *and* the admin actions taken on it (every admin
    # audit row names the target in its detail), so the trail is one story.
    activity = [dict(r) for r in db.execute(
        "SELECT actor, action, study, created_at, detail FROM audit_events "
        "WHERE actor=? OR detail LIKE ? ORDER BY id DESC LIMIT 60",
        (user.get("email") or "", "%" + (user.get("email") or "") + "%")).fetchall()]
    projects = projects_of(user["id"])
    shared_with = [dict(r) for r in db.execute(
        "SELECT study_slug, permission, created_at, accepted_at FROM study_shares "
        "WHERE shared_with_user_id=? OR (shared_with_email=? AND shared_with_email!='') "
        "ORDER BY id DESC LIMIT 20", (user["id"], user.get("email") or "")).fetchall()]
    from core import recovery as recovery_mod
    stats = {
        "projects": len(projects),
        "completes": sum(int(p.get("completes") or 0) for p in projects),
        "points_used": used,
        "actions": len(activity),
        "ledger_rows": len(ledger),
        "shared_with": len(shared_with),
    }
    return {"user": user, "projects": projects, "ledger": ledger, "requests": requests,
            "activity": activity, "shared_with": shared_with, "stats": stats,
            "signin": signin, "recovery": recovery_mod.history(user["id"])}
