"""
Sign-in recovery — forgot username, forgot password, or both.

The flow is deliberately the same whichever of the two a person lost:

1. they enter **their e-mail address or their username** on ``/recover``;
2. SurveyKart issues a **one-time link** (60 minutes, single use, stored hashed in
   the users database). The page it opens shows their username and lets them set
   a new password;
3. delivery is automatic when the server can send mail: SMTP is configured (see
   ``core.mailer``) and the link is e-mailed immediately. When SMTP is not set up,
   the request is **queued in the Admin desk** instead — the admin copies the link
   and hands it over, and the person is told exactly that. Nothing is ever shown on
   screen to whoever typed the address, so knowing an e-mail is never enough.

Every attempt is audited, and re-requesting a link invalidates the earlier one so a
mailbox full of old messages cannot be used to take an account over.
"""

from __future__ import annotations

import hashlib
import secrets
from datetime import datetime, timedelta

from core.mailer import MailError, send_mail, smtp_settings
from models import get_db, now

import core.accounts as accounts

TOKEN_TTL_MINUTES = 60
RESET_KINDS = ("password",)


def _hash(token: str) -> str:
    return hashlib.sha256(str(token or "").encode("utf-8")).hexdigest()


def _plus_minutes(minutes: int) -> str:
    return (datetime.now() + timedelta(minutes=minutes)).strftime("%Y-%m-%dT%H:%M:%S")


def _expired(stamp: str) -> bool:
    try:
        return datetime.strptime(str(stamp or "")[:19], "%Y-%m-%dT%H:%M:%S") < datetime.now()
    except ValueError:
        return True


# ------------------------------------------------------------------ issuing
def issue(user: dict, *, kind: str = "password", requested_by: str = "",
          requested_ip: str = "", note: str = "", token: str | None = None) -> dict:
    """Create a one-time recovery link, e-mail it when possible, else queue it.

    Returns ``{token, link, delivered, reset}`` where ``delivered`` is ``"email"``
    (SMTP accepted it) or ``"admin"`` (waiting in the Admin desk to be handed over).
    """
    kind = kind if kind in RESET_KINDS else "password"
    raw = token or secrets.token_urlsafe(32)
    ts = now()
    db = get_db()
    with db:
        # Only the newest link may work.
        db.execute("UPDATE password_resets SET status='superseded' "
                   "WHERE user_id=? AND status='pending'", (user["id"],))
        cur = db.execute(
            "INSERT INTO password_resets (user_id, token_hash, kind, status, delivered, "
            "requested_by, requested_ip, note, created_at, expires_at) "
            "VALUES (?,?,?,?,?,?,?,?,?,?)",
            (int(user["id"]), _hash(raw), kind, "pending", "", str(requested_by or "")[:120],
             str(requested_ip or "")[:64], str(note or "")[:300], ts,
             _plus_minutes(TOKEN_TTL_MINUTES)),
        )
        reset_id = cur.lastrowid

    link = f"/reset/{raw}"
    delivered, error = "admin", ""
    if smtp_settings():
        try:
            send_mail(user["email"], "Reset your SurveyKart sign-in",
                      _mail_body(user, link))
            delivered = "email"
        except MailError as exc:                      # keep the link in the desk queue
            error = str(exc)
    with db:
        db.execute("UPDATE password_resets SET delivered=?, note=? WHERE id=?",
                   (delivered, (str(note or "") + (" · mail failed: " + error if error else ""))[:300],
                    reset_id))
    return {"token": raw, "link": link, "delivered": delivered, "id": reset_id,
            "expires_at": _plus_minutes(TOKEN_TTL_MINUTES), "user": user}


def _mail_body(user: dict, link: str) -> str:
    name = (user.get("name") or "").split(" ")[0] or "there"
    username = user.get("username") or ""
    lines = [
        f"Hi {name},",
        "",
        "Someone (hopefully you) asked to recover access to this SurveyKart account.",
        "",
    ]
    if username:
        lines += [f"Your SurveyKart username: {username}", ""]
    lines += [
        "Open this link to set a new password. It works once and expires in 60 minutes:",
        link,
        "",
        f"Signed in with: {user.get('email')}",
        "",
        "If this wasn't you, ignore this message — your password will not change.",
        "The SurveyKart team",
    ]
    return "\n".join(lines)


def absolute_link(link: str) -> str:
    """The link as the recipient should open it (absolute when we know the host)."""
    try:
        from flask import request
        return request.url_root.rstrip("/") + link
    except RuntimeError:
        return link


# ------------------------------------------------------------------ reading
def _row(reset_id: int) -> dict | None:
    row = get_db().execute("SELECT * FROM password_resets WHERE id=?", (int(reset_id),)).fetchone()
    return dict(row) if row else None


def by_token(token: str) -> dict | None:
    """The reset a token names, with the account attached, when it is still usable."""
    row = get_db().execute("SELECT * FROM password_resets WHERE token_hash=?",
                           (_hash(token),)).fetchone()
    if not row:
        return None
    data = dict(row)
    data["user"] = accounts.by_id(data["user_id"])
    data["usable"] = (data["status"] == "pending" and not data["used_at"]
                      and not _expired(data["expires_at"]) and bool(data["user"]))
    return data


def link_for(reset_id: int, token: str) -> str:
    return absolute_link(f"/reset/{token}")


def pending_requests() -> list[dict]:
    """Recovery requests waiting for the admin (no SMTP, so nothing was e-mailed)."""
    rows = get_db().execute(
        "SELECT r.*, u.email AS user_email, u.name AS user_name, u.username AS user_username, "
        "u.status AS user_status FROM password_resets r JOIN users u ON u.id=r.user_id "
        "WHERE r.status='pending' AND r.delivered NOT IN ('email', 'handed_over') "
        "ORDER BY r.id DESC LIMIT 100"
    ).fetchall()
    return [dict(r) for r in rows]


def history(user_id: int, limit: int = 20) -> list[dict]:
    rows = get_db().execute(
        "SELECT id, kind, status, delivered, requested_by, requested_ip, note, created_at, "
        "expires_at, used_at FROM password_resets WHERE user_id=? ORDER BY id DESC LIMIT ?",
        (int(user_id), int(limit))).fetchall()
    return [dict(r) for r in rows]


# ------------------------------------------------------------------ consuming
def consume(token: str, new_password: str) -> dict:
    """Set a new password from a valid link. Raises ``ValueError`` with a human reason."""
    reset = by_token(token)
    if not reset:
        raise ValueError("This recovery link is not valid. Request a new one from /recover.")
    if reset["used_at"]:
        raise ValueError("This recovery link has already been used. Request a new one.")
    if reset["status"] != "pending":
        raise ValueError("This recovery link was replaced by a newer one. Use the latest message.")
    if _expired(reset["expires_at"]):
        raise ValueError("This recovery link has expired (links last 60 minutes). Request a new one.")
    user = reset["user"]
    if not user:
        raise ValueError("The account this link belongs to no longer exists.")
    if user.get("role") == "admin" and accounts.is_protected_admin(user):
        raise ValueError("The master admin signs in with ADMIN_PASSWORD; ask the server owner "
                         "to change it in .env and restart the app.")
    updated = accounts.set_password(user["id"], new_password)
    ts = now()
    with get_db() as db:
        db.execute("UPDATE password_resets SET status='used', used_at=? WHERE id=?",
                   (ts, reset["id"]))
        db.execute("UPDATE password_resets SET status='superseded' "
                   "WHERE user_id=? AND status='pending'", (user["id"],))
    return updated


def mark_handed_over(reset_id: int, by: str = "admin") -> dict | None:
    """The admin has given the link to the person — record it, keep the link usable."""
    row = _row(reset_id)
    if not row:
        raise ValueError("Unknown recovery request.")
    with get_db() as db:
        db.execute("UPDATE password_resets SET delivered='handed_over', "
                   "note=TRIM(note || ' · handed over by ' || ?) WHERE id=?",
                   (by, int(reset_id)))
    return _row(reset_id)


def revoke(reset_id: int) -> dict | None:
    row = _row(reset_id)
    if not row:
        raise ValueError("Unknown recovery request.")
    with get_db() as db:
        db.execute("UPDATE password_resets SET status='revoked' WHERE id=?", (int(reset_id),))
    return _row(reset_id)
