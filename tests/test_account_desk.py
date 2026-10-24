"""The Admin Account desk: one account in every context.

Covers the desk page, the per-account detail payload, identity editing with
validation, safe deletion, and the audited support view ("open as user") with
its way back. The rule under test throughout: the admin can reach and change
everything about an account, but never lose their own way home, and never
destroy a project by accident.
"""

from unittest import mock

import pytest

import models

CFG = {
    "language": "en-US",
    "sections": [{"id": "S1", "title": "A"}],
    "questions": [{"id": "Q1", "section": "S1", "type": "open_text", "stem": "x"}],
}


@pytest.fixture(autouse=True)
def google_creds(app):
    app.config["GOOGLE_CLIENT_ID"] = "test-client-id"
    app.config["GOOGLE_CLIENT_SECRET"] = "test-secret"


def auth_on(app):
    app.config["STAFF_AUTH"] = True


def signin(client, email, mode="register"):
    claims = {"email": email, "email_verified": True, "sub": "g-" + email,
              "name": email.split("@")[0].title()}
    with mock.patch("routes.auth.exchange_and_verify", return_value=claims):
        r = client.get("/auth/google", query_string={"mode": mode})
        assert r.status_code == 302
        with client.session_transaction() as sess:
            state = sess["oauth_state"]
        r = client.get("/auth/google/callback", query_string={"state": state, "code": "x"})
        assert r.status_code == 302, r.data
        loc = r.headers["Location"]
    with client.session_transaction() as sess:
        sess["csrf"] = "test-csrf"
    return loc


def H():
    return {"X-CSRF-Token": "test-csrf"}


def out(client):
    client.post("/auth/logout", headers={"X-Requested-With": "fetch"})


def uid_of(app, email):
    with app.app_context():
        return models.get_db().execute("SELECT id FROM users WHERE email=?",
                                       (email,)).fetchone()["id"]


def approve_direct(app, email):
    import core.accounts as accounts
    with app.app_context():
        accounts.set_status(uid_of(app, email), "approved", approved_by="test")


def make_study(client, title, headers=None):
    r = client.post("/api/studio/save", json={"title": title, "cfg": CFG},
                    headers=headers or {})
    assert r.status_code == 200, r.get_json()
    return r.get_json()["slug"]


def setup_admin(client, app):
    """An approved regular account (ana) and an admin (chief) signed in."""
    auth_on(app)
    app.config["ADMIN_EMAILS"] = ["chief@platform.co"]
    signin(client, "ana@research.co")
    approve_direct(app, "ana@research.co")
    out(client)
    signin(client, "chief@platform.co")


# ------------------------------------------------------------------ the page
def test_desk_page_ships_the_master_detail_workspace(app, client):
    setup_admin(client, app)
    html = client.get("/admin/console").data.decode()
    for needle in ("Account desk", "adk-roster", "adk-list", "adk-pane",
                   "adk-search", "All accounts", "css/console.css", "js/console.js"):
        assert needle in html, needle
    assert html.count("<h1") == 1


# ------------------------------------------------------------------ detail payload
def test_account_detail_carries_profile_projects_ledger_and_audit(app, client):
    setup_admin(client, app)
    out(client)
    signin(client, "ana@research.co")
    make_study(client, "Ana's first study", H())
    out(client)
    signin(client, "chief@platform.co")
    ana_id = uid_of(app, "ana@research.co")

    r = client.get("/api/admin/console/account", query_string={"user_id": ana_id})
    assert r.status_code == 200
    d = r.get_json()
    assert d["user"]["email"] == "ana@research.co"
    assert "password_hash" not in d["user"]
    assert [p["title"] for p in d["projects"]] == ["Ana's first study"]
    assert d["stats"]["projects"] == 1 and d["stats"]["points_used"] >= 0
    assert any("Welcome allocation" in row["reason"] for row in d["ledger"])
    assert isinstance(d["activity"], list) and d["activity"]
    assert all(peer["id"] != ana_id for peer in d["peers"])
    assert client.get("/api/admin/console/account",
                      query_string={"user_id": 99999}).status_code == 404


def test_account_detail_is_admin_only(app, client):
    auth_on(app)
    signin(client, "ana@research.co")
    approve_direct(app, "ana@research.co")
    assert client.get("/api/admin/console/account",
                      query_string={"user_id": uid_of(app, "ana@research.co")}).status_code == 403


# ------------------------------------------------------------------ identity edits
def test_admin_edits_identity_with_validation(app, client):
    setup_admin(client, app)
    ana_id = uid_of(app, "ana@research.co")

    r = client.post("/api/admin/console/profile", headers=H(), json={
        "user_id": ana_id, "name": "Ana Research", "username": "ana.r",
        "email": "ana.research@clinic.in"})
    assert r.status_code == 200, r.get_json()
    assert r.get_json()["user"]["email"] == "ana.research@clinic.in"

    import core.accounts as accounts
    with app.app_context():
        saved = accounts.by_id(ana_id)
        assert saved["name"] == "Ana Research" and saved["username"] == "ana.r"

    # invalid e-mail, a taken e-mail and a taken handle are all refused
    assert client.post("/api/admin/console/profile", headers=H(), json={
        "user_id": ana_id, "email": "not-an-email"}).status_code == 400
    assert client.post("/api/admin/console/profile", headers=H(), json={
        "user_id": ana_id, "email": "chief@platform.co"}).status_code == 400
    assert client.post("/api/admin/console/profile", headers=H(), json={
        "user_id": ana_id, "username": "Anaking.admin"}).status_code == 400
    assert client.post("/api/admin/console/profile", headers=H(), json={
        "user_id": ana_id, "username": "no spaces allowed"}).status_code == 400
    assert client.post("/api/admin/console/profile", headers=H(), json={
        "user_id": ana_id, "name": "   "}).status_code == 400


def test_master_admin_identity_is_protected(app, client):
    from config import Config
    auth_on(app)
    r = client.post("/api/auth/admin-login", json={
        "identifier": "Anaking.admin", "password": Config.ADMIN_PASSWORD})
    assert r.status_code == 200, r.get_json()
    with client.session_transaction() as sess:
        sess["csrf"] = "test-csrf"
    master = uid_of(app, "anaking.admin@surveykart.local")

    r = client.post("/api/admin/console/profile", headers=H(), json={
        "user_id": master, "email": "someone@else.in"})
    assert r.status_code == 400 and "protected" in r.get_json()["error"].lower()
    # the display name is still editable
    assert client.post("/api/admin/console/profile", headers=H(), json={
        "user_id": master, "name": "Platform Owner"}).status_code == 200


# ------------------------------------------------------------------ deletion
def test_delete_account_requires_projects_to_be_moved_first(app, client):
    setup_admin(client, app)
    out(client)
    signin(client, "ana@research.co")
    make_study(client, "Ana's study", H())
    out(client)
    signin(client, "chief@platform.co")
    ana_id = uid_of(app, "ana@research.co")
    chief_id = uid_of(app, "chief@platform.co")

    r = client.post("/api/admin/console/delete", headers=H(), json={"user_id": ana_id})
    assert r.status_code == 400 and "still owns" in r.get_json()["error"]
    # the signed-in admin cannot delete themselves
    assert client.post("/api/admin/console/delete",
                       headers=H(), json={"user_id": chief_id}).status_code == 400
    # the master admin is protected
    import core.accounts as accounts
    with app.app_context():
        master = accounts.ensure_master_admin()["id"]
    assert client.post("/api/admin/console/delete",
                       headers=H(), json={"user_id": master}).status_code == 400

    slug = client.get("/api/admin/console/account",
                      query_string={"user_id": ana_id}).get_json()["projects"][0]["slug"]
    assert client.post("/api/admin/console/project/owner", headers=H(),
                       json={"slug": slug, "user_id": chief_id}).status_code == 200
    r = client.post("/api/admin/console/delete", headers=H(), json={"user_id": ana_id})
    assert r.status_code == 200 and r.get_json()["deleted"]["email"] == "ana@research.co"
    assert client.get("/api/admin/console/account",
                      query_string={"user_id": ana_id}).status_code == 404


# ------------------------------------------------------------------ support view
def test_support_view_opens_the_account_and_returns_to_the_desk(app, client):
    setup_admin(client, app)
    app.config["WORKSPACE_ENABLED"] = True
    ana_id = uid_of(app, "ana@research.co")

    r = client.post("/api/admin/console/impersonate", headers=H(), json={"user_id": ana_id})
    assert r.status_code == 200, r.get_json()
    assert r.get_json()["redirect"] == "/workspace/"

    # the admin now sees the app as Ana, with the support strip and a way out
    me = client.get("/api/me").get_json()["user"]
    assert me["email"] == "ana@research.co"
    html = client.get("/workspace/").data.decode()
    assert "Support view" in html and "support-strip" in html
    assert "Exit to account desk" in html and "/auth/impersonate/end" in html
    # ...and the admin desk is out of reach until they leave: no privilege leaks
    assert client.get("/api/admin/console/overview").status_code == 403

    r = client.post("/auth/impersonate/end")
    assert r.status_code == 302 and r.headers["Location"] == "/admin/console"
    assert client.get("/api/me").get_json()["user"]["email"] == "chief@platform.co"
    assert client.get("/admin/console").status_code == 200

    with app.app_context():
        actions = [row["action"] for row in models.get_db().execute(
            "SELECT action FROM audit_events WHERE action LIKE 'console/impersonate%'")]
    assert "console/impersonate" in actions and "console/impersonate-end" in actions


def test_support_view_refuses_admins_pending_accounts_and_non_admins(app, client):
    setup_admin(client, app)
    chief_id = uid_of(app, "chief@platform.co")

    # an admin account is never opened in support view
    assert client.post("/api/admin/console/impersonate", headers=H(),
                       json={"user_id": chief_id}).status_code == 400
    # a pending account has nowhere to be supported
    out(client)
    signin(client, "bo@research.co")
    bo_id = uid_of(app, "bo@research.co")
    out(client)
    signin(client, "chief@platform.co")
    r = client.post("/api/admin/console/impersonate", headers=H(), json={"user_id": bo_id})
    assert r.status_code == 400 and "approved" in r.get_json()["error"]

    # a regular account cannot start one at all
    out(client)
    signin(client, "ana@research.co")
    assert client.post("/api/admin/console/impersonate", headers=H(),
                       json={"user_id": uid_of(app, "ana@research.co")}).status_code == 403


def test_support_view_cannot_nest(app, client):
    setup_admin(client, app)
    ana_id = uid_of(app, "ana@research.co")
    assert client.post("/api/admin/console/impersonate", headers=H(),
                       json={"user_id": ana_id}).status_code == 200
    r = client.post("/api/admin/console/impersonate", headers=H(), json={"user_id": ana_id})
    assert r.status_code in (400, 403)
    assert client.post("/auth/impersonate/end").status_code == 302


# ------------------------------------------------------------------ audit trail
def test_desk_changes_land_in_the_accounts_audit_trail(app, client):
    setup_admin(client, app)
    ana_id = uid_of(app, "ana@research.co")
    client.post("/api/admin/console/points", headers=H(),
                json={"user_id": ana_id, "delta": 40, "reason": "Extra field budget"})
    client.post("/api/admin/console/profile", headers=H(),
                json={"user_id": ana_id, "name": "Ana R"})
    detail = client.get("/api/admin/console/account",
                        query_string={"user_id": ana_id}).get_json()
    reasons = [row["reason"] for row in detail["ledger"]]
    assert "Extra field budget" in reasons
    actions = [ev["action"] for ev in detail["activity"]]
    assert "console/points" in actions and "console/profile" in actions


# ------------------------------------------------------------------ team spaces
def test_deleting_an_account_also_closes_the_spaces_it_created(app, client):
    setup_admin(client, app)
    ana_id = uid_of(app, "ana@research.co")
    chief_id = uid_of(app, "chief@platform.co")
    with app.app_context():
        db = models.get_db()
        with db:
            db.execute("INSERT INTO workspace_teams (name,slug,creator_id,created_at,updated_at) "
                       "VALUES (?,?,?,?,?)", ("Ana's team", "anas-team", ana_id, models.now(), models.now()))
            team_id = db.execute("SELECT id FROM workspace_teams WHERE slug='anas-team'").fetchone()["id"]
            db.execute("INSERT INTO team_members (team_id,user_id,email,status,token,created_at) "
                       "VALUES (?,?,?,?,?,?)", (team_id, chief_id, "chief@platform.co", "accepted",
                                                "tok-1", models.now()))

    r = client.post("/api/admin/console/delete", headers=H(), json={"user_id": ana_id})
    assert r.status_code == 200 and r.get_json()["deleted"]["teams_removed"] == 1
    with app.app_context():
        db = models.get_db()
        assert db.execute("SELECT COUNT(*) FROM workspace_teams WHERE id=?", (team_id,)).fetchone()[0] == 0
        assert db.execute("SELECT COUNT(*) FROM team_members WHERE team_id=?", (team_id,)).fetchone()[0] == 0


def test_last_admin_floor_covers_deletion(app, client):
    setup_admin(client, app)
    chief_id = uid_of(app, "chief@platform.co")
    client.post("/api/auth/register", json={
        "name": "Second Admin", "email": "second.admin@clinic.in", "password": "secret123"})
    import core.accounts as accounts
    with app.app_context():
        seconds = accounts.by_email("second.admin@clinic.in")
        # registration is an approval request; access first, then the extra admin role
        accounts.approve_user(seconds["id"], approved_by="chief@platform.co")
        accounts.set_role(seconds["id"], "admin")
    out(client)
    signin(client, "chief@platform.co")
    # the signed-in admin can never delete themselves, even with a second admin around
    assert client.post("/api/admin/console/delete", headers=H(),
                       json={"user_id": chief_id}).status_code == 400
    # ...but the extra admin can be removed
    r = client.post("/api/admin/console/delete", headers=H(), json={"user_id": seconds["id"]})
    assert r.status_code == 200, r.get_json()


# ------------------------------------------------------------------ portal link
def test_usage_portal_links_each_row_to_the_desk(app, client):
    setup_admin(client, app)
    html = client.get("/admin-portal").data.decode()
    ana_id = uid_of(app, "ana@research.co")
    assert f'/admin/console#user-{ana_id}' in html
    assert "Account desk" in html


# ------------------------------------------------------------------ Kart points
def test_admin_manages_kart_points_from_the_desk(app, client):
    """The desk can add, remove and set Kart points for any regular account."""
    setup_admin(client, app)
    ana_id = uid_of(app, "ana@research.co")

    with app.app_context():
        import core.accounts as accounts
        start = int(accounts.by_id(ana_id)["points_limit"])

    # add 60 points
    r = client.post("/api/admin/console/points", headers=H(),
                    json={"user_id": ana_id, "delta": 60, "reason": "Extra field budget"})
    assert r.status_code == 200, r.get_json()
    body = r.get_json()["user"]
    assert body["points_limit"] == start + 60
    assert body["points_balance"] == start + 60
    # the response is a profile payload, never the stored password hash
    assert "password_hash" not in body

    # remove 25 points
    r = client.post("/api/admin/console/points", headers=H(),
                    json={"user_id": ana_id, "delta": -25})
    assert r.status_code == 200, r.get_json()
    assert r.get_json()["user"]["points_limit"] == start + 35

    # set the exact limit
    r = client.post("/api/admin/console/points", headers=H(),
                    json={"user_id": ana_id, "points_limit": 275})
    assert r.status_code == 200, r.get_json()
    assert r.get_json()["user"]["points_limit"] == 275
    assert "password_hash" not in r.get_json()["user"]

    # each change is in the ledger, with the admin's note
    detail = client.get("/api/admin/console/account",
                        query_string={"user_id": ana_id}).get_json()
    assert detail["user"]["points_limit"] == 275
    reasons = [row["reason"] for row in detail["ledger"]]
    assert "Extra field budget" in reasons

    # no amount at all is a clear 400, and unknown accounts 404
    assert client.post("/api/admin/console/points", headers=H(),
                       json={"user_id": ana_id}).status_code == 400
    assert client.post("/api/admin/console/points", headers=H(),
                       json={"user_id": 99999, "delta": 10}).status_code == 404


def test_points_management_is_admin_only(app, client):
    auth_on(app)
    signin(client, "ana@research.co")
    approve_direct(app, "ana@research.co")
    r = client.post("/api/admin/console/points", headers=H(),
                    json={"user_id": uid_of(app, "ana@research.co"), "delta": 500})
    assert r.status_code == 403


def test_desk_ships_the_overview_kart_control(app, client):
    """The points control is on the default tab, not buried in the ledger."""
    setup_admin(client, app)
    js = client.get("/static/js/console.js").data.decode()
    for needle in ("kartQuickBox", 'data-act="points-apply"', "points-tab",
                   "adk-quick-amt", "adk-quick-reason"):
        assert needle in js, needle
    css = client.get("/static/css/console.css").data.decode()
    assert ".adk-kart-quick" in css and ".adk-row-pts" in css
