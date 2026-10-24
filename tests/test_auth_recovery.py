"""Sign-in without Google, admin approval, the users database, and automatic recovery.

Three promises are covered here:

1. a username + password sign-up is an **approval request** — the admin grants access and
   the 100 Kart points in one click (exactly like Google sign-in);
2. every account-owned row (users, Kart ledger, recovery links) lives in the dedicated
   ``users.db`` file, while studies stay in the survey database;
3. "forgot username or password" is automatic: the link is e-mailed when SMTP exists,
   otherwise it waits in the Admin desk for a hand-over.
"""

import os
import sqlite3

import pytest

import core.accounts as accounts
import core.recovery as recovery
from core.mailer import MailError

REGISTER = "/api/auth/register"
LOGIN = "/api/auth/login"


CSRF = {"X-CSRF-Token": "test-csrf"}


def H(client):
    """Give this client a session CSRF token and the header that matches it."""
    with client.session_transaction() as sess:
        sess["csrf"] = "test-csrf"
    return CSRF


def gated(app):
    """Turn the sign-in gate on: pending accounts must be kept off team surfaces."""
    app.config["STAFF_AUTH"] = True


def register(client, email="new.user@clinic.in", username="new.user", password="secret123",
             name="New User", **extra):
    body = {"name": name, "email": email, "username": username, "password": password}
    body.update(extra)
    return client.post(REGISTER, json=body)


def admin_login(app, client):
    """Sign the test client in as the master admin (ADMIN_PASSWORD from conftest)."""
    app.config["STAFF_AUTH"] = True
    return client.post("/api/auth/login", json={
        "identifier": "Anaking.admin", "password": os.environ["ADMIN_PASSWORD"]})


# ------------------------------------------------------------------ approval flow
def test_password_signup_is_an_approval_request_with_no_points_yet(app, client):
    gated(app)
    r = register(client)
    assert r.status_code == 200, r.get_json()
    out = r.get_json()
    assert out["pending"] is True and out["status"] == "pending"
    assert out["redirect"] == "/welcome"
    assert out["welcome_points_pending"] == 100
    assert out["user"]["points_limit"] == 0
    assert "kart" not in out          # nothing to spend until the admin says yes

    # signed in far enough to watch the live status page, blocked from every team surface
    assert client.get("/studio/").headers["Location"].endswith("/welcome")
    assert client.get("/api/studio/list").status_code == 403
    welcome = client.get("/welcome").data.decode()
    assert "approval request" in welcome.lower()
    assert "100" in welcome

    with app.app_context():
        user = accounts.by_email("new.user@clinic.in")
        assert user["status"] == "pending"
        assert user["points_limit"] == 0
        from core.kart import user_kart_summary
        assert user_kart_summary(user["id"])["points_balance"] == 0


def test_admin_approval_is_what_opens_the_account_and_adds_100_points(app, client):
    register(client)
    with app.app_context():
        user = accounts.by_email("new.user@clinic.in")
        assert user["status"] == "pending"
        before = accounts.account_detail(user["id"])

    # the request is in the admin's queue with the points it will grant
    admin_login(app, client)
    roster = client.get("/api/admin/console/overview").get_json()
    pending = [u for u in roster["users"] if u["email"] == "new.user@clinic.in"]
    assert pending and pending[0]["welcome_points_pending"] == 100
    assert roster["stats"]["pending_recovery"] == 0

    H(client)
    r = client.post("/api/admin/console/decision", headers=CSRF, json={
        "user_id": pending[0]["id"], "decision": "approve"})
    assert r.status_code == 200, r.get_json()
    assert r.get_json()["welcome_points_granted"] == 100

    with app.app_context():
        after = accounts.account_detail(pending[0]["id"])
        assert after["user"]["status"] == "approved"
        assert after["user"]["points_limit"] == 100
    # the welcome allocation is written once, with the reason on the ledger
    assert any("Welcome allocation" in row["reason"] for row in after["ledger"])
    assert before["user"]["status"] == "pending"

    client.post("/auth/logout")
    r = client.post(LOGIN, json={"identifier": "new.user", "password": "secret123"})
    assert r.status_code == 200 and r.get_json()["redirect"] == "/studio/"


def test_pending_account_can_still_sign_in_to_see_its_status(app, client):
    register(client)
    client.post("/auth/logout")
    r = client.post(LOGIN, json={"identifier": "new.user@clinic.in", "password": "secret123"})
    assert r.status_code == 200
    out = r.get_json()
    assert out["pending"] is True and out["redirect"] == "/welcome"
    assert "admin approval" in out["notice"].lower()
    assert client.get("/welcome").status_code == 200


def test_admin_email_bootstrap_stays_approved(app, client):
    app.config["ADMIN_EMAILS"] = ["owner@clinic.in"]
    r = register(client, email="owner@clinic.in", username="owner", name="Owner")
    out = r.get_json()
    assert out["redirect"] in ("/admin/console", "/studio/")
    assert out["kart"]["points_limit"] == accounts.ADMIN_UNLIMITED_POINTS


# ------------------------------------------------------------------ the users file
def test_accounts_live_in_their_own_database_file(app):
    register(app.test_client())
    survey_path = app.config["DB_PATH"]
    users_path = app.config["USERS_DB_PATH"]
    assert os.path.exists(users_path)

    survey = sqlite3.connect(survey_path)
    survey_tables = {r[0] for r in survey.execute("SELECT name FROM sqlite_master WHERE type='table'")}
    assert "users" not in survey_tables
    assert "point_transactions" not in survey_tables
    assert "studies" in survey_tables
    survey.close()

    users = sqlite3.connect(users_path)
    user_tables = {r[0] for r in users.execute("SELECT name FROM sqlite_master WHERE type='table'")}
    assert {"users", "point_transactions", "point_requests", "password_resets"} <= user_tables
    assert "studies" not in user_tables
    assert users.execute("SELECT COUNT(*) FROM users").fetchone()[0] == 1
    users.close()


def test_a_legacy_single_file_install_is_migrated_once(tmp_path):
    """Before the split, accounts lived in survey.db — booting moves them across."""
    from app import create_app

    main = str(tmp_path / "survey.db")
    conn = sqlite3.connect(main)
    conn.executescript("""
        CREATE TABLE users (id INTEGER PRIMARY KEY, email TEXT UNIQUE NOT NULL,
            username TEXT NOT NULL DEFAULT '', password_hash TEXT NOT NULL DEFAULT '',
            name TEXT NOT NULL DEFAULT '', picture TEXT NOT NULL DEFAULT '',
            google_sub TEXT NOT NULL DEFAULT '', role TEXT NOT NULL DEFAULT 'user',
            status TEXT NOT NULL DEFAULT 'pending', points_limit INTEGER NOT NULL DEFAULT 100,
            created_at TEXT NOT NULL, approved_at TEXT NOT NULL DEFAULT '',
            approved_by TEXT NOT NULL DEFAULT '', last_login TEXT NOT NULL DEFAULT '');
        CREATE TABLE point_transactions (id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL, delta INTEGER NOT NULL, balance_after INTEGER NOT NULL,
            reason TEXT NOT NULL DEFAULT '', actor TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL);
        INSERT INTO users (email, username, name, role, status, created_at)
            VALUES ('legacy@clinic.in', 'legacy', 'Legacy Person', 'user', 'approved', '2026-01-01T09:00:00');
        INSERT INTO point_transactions (user_id, delta, balance_after, reason, actor, created_at)
            VALUES (1, 100, 100, 'Welcome allocation on SurveyKart registration (100 pts)', 'system',
                    '2026-01-01T09:00:00');
    """)
    conn.commit()
    conn.close()

    app = create_app({"TESTING": True, "STAFF_AUTH": False, "DB_PATH": main,
                      "USERS_DB_PATH": str(tmp_path / "users.db"),
                      "VOICE_DIR": str(tmp_path / "v"), "NARRATION_DIR": str(tmp_path / "n"),
                      "MEDIA_DIR": str(tmp_path / "m")})
    with app.app_context():
        assert accounts.by_email("legacy@clinic.in")["name"] == "Legacy Person"

    users = sqlite3.connect(str(tmp_path / "users.db"))
    assert users.execute("SELECT email FROM users").fetchall() == [("legacy@clinic.in",)]
    assert users.execute("SELECT delta FROM point_transactions").fetchall() == [(100,)]
    users.close()
    leftover = sqlite3.connect(main)
    assert "users" not in {r[0] for r in leftover.execute(
        "SELECT name FROM sqlite_master WHERE type='table'")}
    leftover.close()


# ------------------------------------------------------------------ recovery: the queue
def test_recovery_request_without_smtp_is_queued_for_the_admin(app, client):
    gated(app)
    register(client)
    client.post("/auth/logout")

    r = client.post("/api/auth/recover/request", json={"identifier": "new.user@clinic.in"})
    assert r.status_code == 200, r.get_json()
    out = r.get_json()
    assert out["sent"] is True and out["delivery"] == "admin"
    assert "admin" in out["message"].lower()
    assert "/reset/" not in str(out)          # never hand the link to the requester

    admin_login(app, client)
    q = client.get("/api/admin/console/recovery").get_json()
    assert q["count"] == 1 and q["mail_configured"] is False
    row = q["pending"][0]
    assert row["user_email"] == "new.user@clinic.in"
    assert "token_hash" in row and row["token_hash"]

    # the admin creates a fresh, copyable link and marks it handed over
    H(client)
    issued = client.post("/api/admin/console/recovery/issue", headers=CSRF,
                         json={"user_id": row["user_id"]})
    assert issued.status_code == 200, issued.get_json()
    link = issued.get_json()["link"]
    assert "/reset/" in link and issued.get_json()["delivery"] == "admin"

    q2 = client.get("/api/admin/console/recovery").get_json()
    assert q2["count"] == 1                    # the new link replaces the old request
    done = client.post("/api/admin/console/recovery/decide", headers=CSRF, json={
        "reset_id": q2["pending"][0]["id"], "action": "handed_over"})
    assert done.status_code == 200
    assert client.get("/api/admin/console/recovery").get_json()["count"] == 0


def test_username_reminder_and_password_reset_through_the_link(app, client):
    register(client, email="rita@clinic.in", username="rita.shah", password="oldpassword1")
    with app.app_context():
        accounts.approve_user(accounts.by_email("rita@clinic.in")["id"])
    client.post("/auth/logout")

    # forgot the *username*: look it up by e-mail, then ask for a link
    look = client.post("/api/auth/recover", json={"identifier": "rita@clinic.in"}).get_json()
    assert look["found"] is True and look["has_password"] is True
    assert client.post("/api/auth/recover/request",
                       json={"identifier": "rita@clinic.in"}).get_json()["sent"] is True

    # forgot the *password*: a bare handle is a username lookup
    assert client.post("/api/auth/recover",
                       json={"identifier": "rita.shah"}).get_json()["found"] is True

    admin_login(app, client)
    row = client.get("/api/admin/console/recovery").get_json()["pending"][0]
    H(client)
    link = client.post("/api/admin/console/recovery/issue", headers=CSRF,
                       json={"user_id": row["user_id"]}).get_json()["link"]
    token = link.rsplit("/", 1)[-1]

    client.post("/auth/logout")
    page = client.get(f"/reset/{token}")
    assert page.status_code == 200
    html = page.data.decode()
    assert "rita.shah" in html                 # the link itself reminds them of the username
    assert "rita@clinic.in" in html

    bad = client.post("/api/auth/reset", json={"token": token, "password": "short",
                                               "confirm": "short"})
    assert bad.status_code == 400
    mismatch = client.post("/api/auth/reset", json={"token": token, "password": "brandnewpass",
                                                    "confirm": "different"})
    assert mismatch.status_code == 400

    ok = client.post("/api/auth/reset", json={"token": token, "password": "brandnewpass",
                                              "confirm": "brandnewpass"})
    assert ok.status_code == 200, ok.get_json()
    assert ok.get_json()["redirect"] == "/studio/"
    assert client.get("/api/me").get_json()["user"]["email"] == "rita@clinic.in"

    # the old password is gone, the link is single use
    client.post("/auth/logout")
    assert client.post(LOGIN, json={"identifier": "rita.shah",
                                    "password": "oldpassword1"}).status_code == 401
    assert client.post(LOGIN, json={"identifier": "rita.shah",
                                    "password": "brandnewpass"}).status_code == 200
    client.post("/auth/logout")
    assert client.get(f"/reset/{token}").status_code == 410
    assert client.post("/api/auth/reset", json={"token": token, "password": "anotherpass",
                                                "confirm": "anotherpass"}).status_code == 400


def test_expired_or_revoked_links_are_refused(app, client):
    register(client, email="late@clinic.in", username="late.user")
    with app.app_context():
        user = accounts.by_email("late@clinic.in")
        old = recovery.issue(user, requested_by="test")["token"]
        db = __import__("models").get_db()
        with db:
            db.execute("UPDATE password_resets SET expires_at='2000-01-01T00:00:00'")
    client.post("/auth/logout")
    assert client.get(f"/reset/{old}").status_code == 410
    assert client.post("/api/auth/reset", json={"token": old, "password": "whatever1",
                                                "confirm": "whatever1"}).status_code == 400

    with app.app_context():
        user = accounts.by_email("late@clinic.in")
        fresh = recovery.issue(user, requested_by="test")
        recovery.revoke(fresh["id"])
    assert client.get(f"/reset/{fresh['token']}").status_code == 410


def test_a_new_request_supersedes_the_previous_link(app, client):
    register(client, email="twice@clinic.in", username="twice.user")
    client.post("/auth/logout")
    client.post("/api/auth/recover/request", json={"identifier": "twice@clinic.in"})
    client.post("/api/auth/recover/request", json={"identifier": "twice@clinic.in"})
    with app.app_context():
        user = accounts.by_email("twice@clinic.in")
        rows = recovery.history(user["id"])
        assert [r["status"] for r in rows] == ["pending", "superseded"]


def test_unknown_address_answers_generically_and_leaks_nothing(app, client):
    r = client.post("/api/auth/recover/request", json={"identifier": "ghost@clinic.in"})
    assert r.status_code == 200
    out = r.get_json()
    assert out["sent"] is False and "exists" in out["message"].lower()
    admin_login(app, client)
    assert client.get("/api/admin/console/recovery").get_json()["count"] == 0


# ------------------------------------------------------------------ recovery: SMTP
def test_with_smtp_the_link_is_emailed_and_never_queued(app, client, monkeypatch):
    sent = {}

    def fake_send(to, subject, body):
        sent.update({"to": to, "subject": subject, "body": body})

    monkeypatch.setattr(recovery, "smtp_settings", lambda: {"host": "smtp.test"})
    monkeypatch.setattr(recovery, "send_mail", fake_send)

    register(client, email="mailed@clinic.in", username="mailed.user")
    client.post("/auth/logout")
    out = client.post("/api/auth/recover/request",
                      json={"identifier": "mailed@clinic.in"}).get_json()
    assert out["delivery"] == "email" and "inbox" in out["message"].lower()
    assert sent["to"] == "mailed@clinic.in"
    assert "/reset/" in sent["body"] and "Your SurveyKart username: mailed.user" in sent["body"]

    admin_login(app, client)
    assert client.get("/api/admin/console/recovery").get_json()["count"] == 0


def test_a_mail_failure_falls_back_to_the_admin_queue(app, client, monkeypatch):
    def boom(*_a, **_k):
        raise MailError("smtp down")

    monkeypatch.setattr(recovery, "smtp_settings", lambda: {"host": "smtp.test"})
    monkeypatch.setattr(recovery, "send_mail", boom)

    register(client, email="fallback@clinic.in", username="fallback.user")
    client.post("/auth/logout")
    out = client.post("/api/auth/recover/request",
                      json={"identifier": "fallback@clinic.in"}).get_json()
    assert out["delivery"] == "admin"
    admin_login(app, client)
    q = client.get("/api/admin/console/recovery").get_json()
    assert q["count"] == 1 and "mail failed" in q["pending"][0]["note"]


# ------------------------------------------------------------------ guards
def test_the_master_admin_is_not_recoverable_by_link(app, client):
    with app.app_context():
        accounts.ensure_master_admin()
    out = client.post("/api/auth/recover/request",
                      json={"identifier": "Anaking.admin"}).get_json()
    assert out["sent"] is False and "ADMIN_PASSWORD" in out["message"]
    with app.app_context():
        master_id = accounts.by_username("Anaking.admin")["id"]
    admin_login(app, client)
    H(client)
    r = client.post("/api/admin/console/recovery/issue", headers=CSRF,
                    json={"user_id": master_id})
    assert r.status_code == 400


def test_recovery_queue_is_admin_only_and_throttled(app, client, monkeypatch):
    gated(app)
    register(client, email="throttle@clinic.in", username="throttle.user")
    client.post("/auth/logout")
    assert client.get("/api/admin/console/recovery").status_code == 401

    monkeypatch.setattr("routes.auth._login_throttled", lambda: True)
    r = client.post("/api/auth/recover/request", json={"identifier": "throttle@clinic.in"})
    assert r.status_code == 429


def test_the_desk_shows_the_recovery_panel(app, client):
    gated(app)
    admin_login(app, client)
    html = client.get("/admin/console").data.decode()
    assert "adk-recovery" in html and "Sign-in recovery" in html
    assert "Sign-in" in html


def test_account_detail_carries_the_signin_summary(app, client):
    gated(app)
    register(client, email="detail@clinic.in", username="detail.user", password="secret123")
    with app.app_context():
        uid = accounts.by_email("detail@clinic.in")["id"]
    admin_login(app, client)
    detail = client.get(f"/api/admin/console/account?user_id={uid}").get_json()
    assert detail["signin"]["username"] == "detail.user"
    assert detail["signin"]["has_password"] is True
    assert detail["signin"]["google"] is False
    assert detail["recovery"] == []
