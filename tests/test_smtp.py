"""SMTP settings: writable from the admin console, never readable back."""

from __future__ import annotations

import json
import os

import pytest

from core import mailer


@pytest.fixture()
def mail_file(tmp_path, monkeypatch):
    path = tmp_path / "mail.json"
    monkeypatch.setattr(mailer, "MAIL_CONFIG", path)
    for key in ("BEACON_SMTP_HOST", "BEACON_SMTP_PORT", "BEACON_SMTP_USER",
                "BEACON_SMTP_PASSWORD", "BEACON_SMTP_FROM", "BEACON_SMTP_TLS"):
        monkeypatch.delenv(key, raising=False)
    return path


def test_settings_are_saved_with_0600_and_password_never_returned(client, mail_file):
    r = client.post("/api/admin/console/smtp", json={
        "host": "smtp.gmail.com", "port": 587, "tls": "starttls",
        "user": "research@example.com", "password": "app-password",
        "from": "research@example.com"})
    assert r.status_code == 200
    assert "app-password" not in r.get_data(as_text=True)
    saved = json.loads(mail_file.read_text())
    assert saved["host"] == "smtp.gmail.com" and saved["password"] == "app-password"
    assert oct(mail_file.stat().st_mode)[-3:] == "600"
    view = client.get("/api/admin/console/smtp").get_json()
    assert view["smtp"]["configured"] is True
    assert view["smtp"]["password_set"] is True
    assert "password" not in view["smtp"]


def test_blank_password_keeps_the_stored_one(client, mail_file):
    client.post("/api/admin/console/smtp", json={"host": "smtp.example.com", "user": "u",
                                                 "password": "secret", "from": "a@example.com"})
    client.post("/api/admin/console/smtp", json={"host": "smtp2.example.com", "user": "u",
                                                 "password": "", "from": "a@example.com"})
    saved = json.loads(mail_file.read_text())
    assert saved["host"] == "smtp2.example.com"
    assert saved["password"] == "secret"


def test_rejects_bad_port_and_missing_host(client, mail_file):
    assert client.post("/api/admin/console/smtp", json={"host": ""}).status_code == 400
    assert client.post("/api/admin/console/smtp", json={"host": "h", "port": 70000}).status_code == 400
    assert client.post("/api/admin/console/smtp", json={"host": "h", "tls": "weird"}).status_code == 400


def test_connection_check_explains_a_refused_port(client, mail_file):
    r = client.post("/api/admin/console/smtp", json={"host": "127.0.0.1", "port": 9,
                                                    "tls": "none", "user": ""})
    v = r.get_json()["verify"]
    assert v["ok"] is False
    assert "hint" in v and v["error"]


def test_test_send_requires_a_recipient(client, mail_file):
    client.post("/api/admin/console/smtp", json={"host": "127.0.0.1", "port": 9, "tls": "none"})
    assert client.post("/api/admin/console/smtp/test", json={"to": "nope"}).status_code == 400
    r = client.post("/api/admin/console/smtp/test", json={"to": "a@example.com"})
    assert r.status_code == 400
    assert r.get_json()["ok"] is False


def test_clear_removes_the_file(client, mail_file):
    client.post("/api/admin/console/smtp", json={"host": "smtp.example.com"})
    assert mail_file.exists()
    r = client.post("/api/admin/console/smtp", json={"clear": True})
    assert r.status_code == 200 and not mail_file.exists()
    assert client.get("/api/admin/console/smtp").get_json()["smtp"]["configured"] is False


def test_team_invite_is_emailed_when_smtp_is_configured(client, monkeypatch):
    """Inviting a teammate by e-mail sends the /share/<token> link (best effort)."""
    from core import mailer as mail_mod
    monkeypatch.setattr(mail_mod, "smtp_settings", lambda: {"host": "h", "port": 25, "tls": "none"})
    sent = []
    monkeypatch.setattr(mail_mod, "send_mail",
                        lambda to, subject, body, settings=None: sent.append((to, subject, body)))
    r = client.post("/api/workspace/teams/create",
                    json={"team_name": "Hindi Team", "email": "mate@example.com",
                          "study_slug": ""})
    assert r.status_code == 200, r.get_data(as_text=True)
    d = r.get_json()
    assert d["invite_mail"] == "sent" and d["share_url"].startswith("http")
    assert sent and sent[0][0] == "mate@example.com"
    assert "/share/" in sent[0][2]


def test_team_invite_queues_without_smtp(client, monkeypatch):
    from core import mailer as mail_mod
    monkeypatch.setattr(mail_mod, "smtp_settings", lambda: None)
    r = client.post("/api/workspace/teams/create",
                    json={"team_name": "No Mail Team", "email": "mate2@example.com"})
    d = r.get_json()
    assert r.status_code == 200 and d["invite_mail"] == "queued"
