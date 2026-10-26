"""
Study invites and reminders: SMTP when the team has configured it, always an outbox row.

Sending never depends on a mail server being reachable.  Every invite and reminder is written
to the ``invites`` table with the link it carried and a status:

* ``sent``   - the SMTP server accepted it
* ``queued`` - no SMTP is configured, so the row is the record of what would have gone out
* ``failed`` - SMTP is configured but the send raised (the reason is stored)

Credentials are read from the environment and then from ``data/mail.json`` (never from the
database, and never echoed back to the browser - :func:`smtp_status` reports the host and the
from-address only)::

    BEACON_SMTP_HOST, BEACON_SMTP_PORT, BEACON_SMTP_USER, BEACON_SMTP_PASSWORD,
    BEACON_SMTP_FROM, BEACON_SMTP_TLS=starttls|ssl|none

``data/mail.json`` takes the same names in lower case, e.g.
``{"host": "smtp.example.com", "port": 587, "user": "…", "password": "…", "from": "…"}``.
"""

from __future__ import annotations

import json
import os
import smtplib
import ssl
from email.message import EmailMessage
from pathlib import Path

MAIL_CONFIG = Path(__file__).resolve().parent.parent / "data" / "mail.json"
DEFAULT_PORT = 587


class MailError(RuntimeError):
    """Raised when the SMTP server refuses or cannot be reached."""


def _from_file() -> dict:
    try:
        data = json.loads(MAIL_CONFIG.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    return data if isinstance(data, dict) else {}


def smtp_settings() -> dict | None:
    """The SMTP settings in force, or ``None`` when no host has been configured."""
    src = _from_file()
    pick = lambda key, env: os.environ.get(env) or src.get(key) or ""
    host = pick("host", "BEACON_SMTP_HOST")
    if not host:
        return None
    tls = (pick("tls", "BEACON_SMTP_TLS") or "starttls").lower()
    try:
        port = int(pick("port", "BEACON_SMTP_PORT") or (465 if tls == "ssl" else DEFAULT_PORT))
    except ValueError:
        port = DEFAULT_PORT
    return {
        "host": host.strip(),
        "port": port,
        "user": pick("user", "BEACON_SMTP_USER").strip(),
        "password": pick("password", "BEACON_SMTP_PASSWORD"),
        "from": (pick("from", "BEACON_SMTP_FROM") or pick("user", "BEACON_SMTP_USER")
                 or f"no-reply@{host.split(':')[0]}").strip(),
        "tls": tls if tls in ("starttls", "ssl", "none") else "starttls",
    }


def smtp_status() -> dict:
    """What the Studio may show about mail: host and sender, never the password."""
    s = smtp_settings()
    if not s:
        return {"configured": False, "host": "", "from": "", "tls": "",
                "hint": "Set BEACON_SMTP_HOST (and user/password) or add data/mail.json to send "
                        "for real - invites are recorded in the outbox either way."}
    src = _from_file()
    using_env = bool(os.environ.get("BEACON_SMTP_HOST"))
    return {"configured": True, "host": s["host"], "port": s["port"], "from": s["from"],
            "user": s["user"], "tls": s["tls"], "hint": "",
            "password_set": bool(s["password"]),
            "source": "environment" if using_env else ("data/mail.json" if src else "environment"),
            "file": str(MAIL_CONFIG) if MAIL_CONFIG.exists() else ""}


def save_settings(values: dict) -> dict:
    """Write SMTP settings to ``data/mail.json`` (0600) and return the sanitised view.

    The password is write-only: an empty value keeps the one already stored, so an
    admin can correct the host or port without re-typing the secret.
    """
    current = _from_file()
    host = str(values.get("host") or "").strip()
    if not host:
        raise MailError("SMTP host is required")
    tls = str(values.get("tls") or "starttls").strip().lower()
    if tls not in ("starttls", "ssl", "none"):
        raise MailError("tls must be starttls, ssl or none")
    try:
        port = int(values.get("port") or (465 if tls == "ssl" else DEFAULT_PORT))
    except (TypeError, ValueError):
        raise MailError("port must be a number")
    if not (1 <= port <= 65535):
        raise MailError("port must be between 1 and 65535")
    password = values.get("password")
    if password in (None, ""):
        password = current.get("password", "")
    data = {
        "host": host,
        "port": port,
        "user": str(values.get("user") or "").strip(),
        "password": str(password or ""),
        "from": str(values.get("from") or "").strip(),
        "tls": tls,
    }
    try:
        MAIL_CONFIG.parent.mkdir(parents=True, exist_ok=True)
        tmp = MAIL_CONFIG.with_suffix(".json.tmp")
        tmp.write_text(json.dumps(data, indent=2), encoding="utf-8")
        os.chmod(tmp, 0o600)
        tmp.replace(MAIL_CONFIG)
    except OSError as e:
        raise MailError(f"could not write {MAIL_CONFIG}: {e}") from e
    return {"configured": True, "host": host, "port": port, "user": data["user"],
            "from": data["from"] or data["user"] or f"no-reply@{host}", "tls": tls,
            "hint": "", "source": "data/mail.json", "password_set": bool(data["password"])}


def clear_settings() -> None:
    """Remove the stored file; environment variables (if any) take over again."""
    try:
        MAIL_CONFIG.unlink()
    except FileNotFoundError:
        pass


def verify(settings: dict | None = None) -> dict:
    """Open a connection and authenticate, without sending a message.

    Returns ``{"ok": True}`` or ``{"ok": False, "error": ..., "hint": ...}`` with a
    sentence that names the likely cause - the single most useful thing when a
    hosted SMTP setup does not work.
    """
    s = settings or smtp_settings()
    if not s:
        return {"ok": False, "error": "no SMTP server configured",
                "hint": "Set BEACON_SMTP_HOST or save the form below."}
    try:
        if s["tls"] == "ssl":
            with smtplib.SMTP_SSL(s["host"], s["port"], timeout=12,
                                  context=ssl.create_default_context()) as smtp:
                smtp.ehlo()
                if s["user"]:
                    smtp.login(s["user"], s["password"])
            return {"ok": True, "host": s["host"], "port": s["port"], "tls": s["tls"]}
        with smtplib.SMTP(s["host"], s["port"], timeout=12) as smtp:
            smtp.ehlo()
            if s["tls"] == "starttls":
                smtp.starttls(context=ssl.create_default_context())
                smtp.ehlo()
            if s["user"]:
                smtp.login(s["user"], s["password"])
        return {"ok": True, "host": s["host"], "port": s["port"], "tls": s["tls"]}
    except smtplib.SMTPAuthenticationError as e:
        return {"ok": False, "error": "the SMTP server rejected the username/password",
                "detail": str(e)[:300],
                "hint": "Gmail and Google Workspace need a 16-character App Password "
                        "(2-Step Verification → App passwords), not the account password. "
                        "Microsoft 365 needs SMTP AUTH enabled for the mailbox."}
    except smtplib.SMTPServerDisconnected:
        return {"ok": False, "error": "the server closed the connection",
                "hint": "Usually a TLS mismatch: try port 465 with SSL, or 587 with STARTTLS."}
    except ssl.SSLError as e:
        return {"ok": False, "error": "TLS handshake failed", "detail": str(e)[:300],
                "hint": "Port 465 expects SSL; port 587 expects STARTTLS. Check the certificate "
                        "chain on the host if the provider uses a private CA."}
    except (OSError, smtplib.SMTPException) as e:
        return {"ok": False, "error": str(e) or e.__class__.__name__,
                "hint": "Check the host/port, that outbound SMTP is allowed by the hosting "
                        "firewall (many block 25; 465/587 are usually open) and DNS."}


def send_test(to: str) -> dict:
    """Send one real message so the whole path is proven, not just the login."""
    s = smtp_settings()
    if not s:
        return {"ok": False, "error": "no SMTP server configured"}
    try:
        send_mail(to, "SurveyKart SMTP test", "SMTP is configured correctly. "
                  "Invitations and demo-request alerts will be delivered.", s)
    except MailError as e:
        v = verify(s)
        v["error"] = v.get("error") or str(e)
        return {"ok": False, "error": v.get("error"), "detail": str(e)[:300],
                "hint": v.get("hint", "")}
    return {"ok": True, "to": to, "host": s["host"], "from": s["from"]}


def send_mail(to: str, subject: str, body: str, settings: dict | None = None) -> None:
    """Send one plain-text message. Raises :class:`MailError` if it cannot be delivered."""
    s = settings or smtp_settings()
    if not s:
        raise MailError("no SMTP server configured")
    msg = EmailMessage()
    msg["From"] = s["from"]
    msg["To"] = to
    msg["Subject"] = subject
    msg.set_content(body)
    try:
        if s["tls"] == "ssl":
            with smtplib.SMTP_SSL(s["host"], s["port"], timeout=20,
                                  context=ssl.create_default_context()) as smtp:
                if s["user"]:
                    smtp.login(s["user"], s["password"])
                smtp.send_message(msg)
            return
        with smtplib.SMTP(s["host"], s["port"], timeout=20) as smtp:
            smtp.ehlo()
            if s["tls"] == "starttls":
                smtp.starttls(context=ssl.create_default_context())
                smtp.ehlo()
            if s["user"]:
                smtp.login(s["user"], s["password"])
            smtp.send_message(msg)
    except (OSError, smtplib.SMTPException) as e:
        raise MailError(str(e) or e.__class__.__name__) from e


def invite_subject(study_title: str, kind: str = "invite") -> str:
    if kind == "reminder":
        return f"Reminder: {study_title}"
    return f"You are invited: {study_title}"


def invite_body(study_title: str, link: str, message: str = "", kind: str = "invite") -> str:
    """The plain-text invite/reminder. The link always carries the recipient's own token."""
    lines = []
    if message.strip():
        lines += [message.strip(), ""]
    if kind == "reminder":
        lines += [f"A quick reminder about {study_title}.", ""]
    else:
        lines += [f"You have been invited to take part in {study_title}.", ""]
    lines += ["Take part here:", link, ""]
    lines += ["This link is personal to you - please do not forward it.",
              "The research team"]
    return "\n".join(lines)
