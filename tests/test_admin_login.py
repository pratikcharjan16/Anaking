"""Separate Admin Login (/admin-login): the platform owner's own front door.

Kept apart from user sign-in: it accepts ONLY the protected master admin
(Anaking.admin + ADMIN_PASSWORD) or approved admin accounts, lands in the
Admin Console (where pending approval requests wait), and explains plainly
when ADMIN_PASSWORD isn't configured instead of failing silently.

conftest pins ADMIN_PASSWORD=test-only-admin-password before import.
"""

import os
from unittest import mock

import pytest

ADMIN_PW = os.environ["ADMIN_PASSWORD"]


def H(client):
    """CSRF header matching the session token (login rotates the real one in)."""
    with client.session_transaction() as sess:
        sess["csrf"] = "test-csrf"
    return {"X-CSRF-Token": "test-csrf"}


def admin_login(client, ident="Anaking.admin", password=ADMIN_PW, **extra):
    return client.post("/api/auth/admin-login",
                       json={"identifier": ident, "password": password, **extra})


def make_pending_user(app, email="new.r@clinic.in", name="New R"):
    """A pending Google-style account = an approval request (no HTTP needed)."""
    import core.accounts as accounts
    with app.app_context():
        return accounts.upsert_from_claims(
            {"email": email, "email_verified": True, "sub": "g-" + email, "name": name})


def out(client):
    client.post("/auth/logout", headers={"X-Requested-With": "fetch"})


# ------------------------------------------------------------------ the page
def test_admin_login_page_is_separate_and_blank(app, client):
    app.config["STAFF_AUTH"] = True
    r = client.get("/admin-login")
    assert r.status_code == 200
    html = r.data.decode()
    assert "Admin login" in html and "separate from user sign-in" in html
    assert 'value="Anaking.admin"' not in html
    assert 'placeholder="Enter your admin username"' in html
    assert "First time, or locked out?" not in html
    assert "ADMIN_PASSWORD" not in html
    assert "ADMIN_EMAILS" not in html
    assert "Anaking.admin" not in html
    assert "/signin" in html                                # way back for regular users
    # and the user sign-in page points owners here
    assert "/admin-login" in client.get("/signin").data.decode()


def test_anonymous_admin_pages_redirect_to_admin_login(app, client):
    app.config["STAFF_AUTH"] = True
    for page in ("/admin/console", "/admin-portal"):
        r = client.get(page)
        assert r.status_code == 302 and "/admin-login" in r.headers["Location"], page
    # ...while team apps still use the regular user sign-in
    assert "/signin" in client.get("/studio/").headers["Location"]


# ------------------------------------------------------------------ master admin
def test_master_admin_logs_in_and_lands_in_the_console(app, client):
    app.config["STAFF_AUTH"] = True
    r = admin_login(client)
    assert r.status_code == 200, r.get_json()
    assert r.get_json()["redirect"] == "/admin/console"
    assert r.get_json()["user"]["role"] == "admin"
    assert client.get("/admin/console").status_code == 200
    assert client.get("/api/admin/console/overview").status_code == 200
    # already-admin visits to the login page go straight through
    r = client.get("/admin-login")
    assert r.status_code == 302 and "/admin/console" in r.headers["Location"]


def test_admin_login_can_approve_the_pending_request(app, client):
    """The whole point of the page: log in -> approve -> user has 100 pts."""
    app.config["STAFF_AUTH"] = True
    pending = make_pending_user(app)
    assert pending["status"] == "pending" and pending["points_limit"] == 0
    assert admin_login(client).status_code == 200
    ov = client.get("/api/admin/console/overview").get_json()
    assert ov["stats"]["pending"] >= 1
    r = client.post("/api/admin/console/decision",
                    json={"user_id": pending["id"], "decision": "approve"}, headers=H(client))
    assert r.get_json()["welcome_points_granted"] == 100
    assert r.get_json()["user"]["points_limit"] == 100


def test_wrong_admin_password_is_a_clear_no(app, client):
    app.config["STAFF_AUTH"] = True
    r = admin_login(client, password="definitely-wrong")
    assert r.status_code == 401 and "Incorrect admin password" in r.get_json()["error"]
    assert client.get("/admin/console").status_code in (302, 401, 403)


def test_unconfigured_admin_password_notice_is_not_shown(app, client):
    app.config["STAFF_AUTH"] = True
    with mock.patch("core.accounts.master_admin_password_configured", return_value=False):
        html = client.get("/admin-login").data.decode()
        assert "isn't set up on this server yet" not in html
        assert "Please contact the platform administrator" not in html
        assert "ADMIN_PASSWORD" not in html
        assert "Anaking.admin" not in html
        r = admin_login(client)
        assert r.status_code == 503
        assert r.get_json()["code"] == "admin_password_unconfigured"
        assert "ADMIN_PASSWORD" in r.get_json()["error"]


def test_master_admin_email_form_also_works(app, client):
    app.config["STAFF_AUTH"] = True
    assert admin_login(client, ident="anaking.admin@surveykart.local").status_code == 200


# ------------------------------------------------------------------ who is refused
def test_regular_user_cannot_use_admin_login(app, client, approve):
    app.config["STAFF_AUTH"] = True
    client.post("/api/auth/register", json={
        "name": "Regular Rita", "email": "rita@clinic.in", "password": "secret123"})
    approve("rita@clinic.in")
    out(client)
    r = admin_login(client, ident="rita@clinic.in", password="secret123")
    assert r.status_code == 403 and r.get_json()["code"] == "not_admin"
    # the same credentials still work on the normal sign-in (lands in Studio)
    r = client.post("/api/auth/login", json={"identifier": "rita@clinic.in", "password": "secret123"})
    assert r.status_code == 200 and r.get_json()["redirect"] == "/studio/"


def test_google_only_account_is_pointed_at_the_google_button(app, client):
    app.config["STAFF_AUTH"] = True
    make_pending_user(app, email="g.only@clinic.in")
    r = admin_login(client, ident="g.only@clinic.in", password="whatever123")
    assert r.status_code == 401 and "signs in with Google" in r.get_json()["error"]


def test_admin_account_with_its_own_password_can_use_admin_login(app, client):
    app.config["STAFF_AUTH"] = True
    app.config["ADMIN_EMAILS"] = ["boss@clinic.in"]        # registers as approved admin
    client.post("/api/auth/register", json={
        "name": "Boss", "email": "boss@clinic.in", "password": "bosssecret"})
    out(client)
    r = admin_login(client, ident="boss@clinic.in", password="bosssecret")
    assert r.status_code == 200 and r.get_json()["redirect"] == "/admin/console"


def test_admin_via_regular_signin_also_lands_in_the_console(app, client):
    app.config["STAFF_AUTH"] = True
    r = client.post("/api/auth/login",
                    json={"identifier": "Anaking.admin", "password": ADMIN_PW})
    assert r.status_code == 200 and r.get_json()["redirect"] == "/admin/console"
