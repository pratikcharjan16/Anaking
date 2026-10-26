"""Platform accounts: Google sign-in, one profile per e-mail, admin approval,
per-user project scoping, and the admin console.

The Google round trip is mocked at one seam (``routes.auth.exchange_and_verify``);
everything after the claims - profile creation, sessions, approval gates,
ownership and the console - runs against the real database.
"""

from unittest import mock

import pytest

import models


@pytest.fixture(autouse=True)
def google_creds(app):
    """The OAuth client is configured the way production would be; the network
    round trip itself stays mocked in the signin() helper."""
    app.config["GOOGLE_CLIENT_ID"] = "test-client-id"
    app.config["GOOGLE_CLIENT_SECRET"] = "test-secret"


CFG = {
    "language": "en-US",
    "sections": [{"id": "S1", "title": "A"}],
    "questions": [{"id": "Q1", "section": "S1", "type": "open_text", "stem": "x"}],
}

CLAIMS = {
    "ana@research.co": {"email": "ana@research.co", "email_verified": True,
                        "sub": "g-ana", "name": "Ana"},
    "bo@research.co": {"email": "bo@research.co", "email_verified": True,
                       "sub": "g-bo", "name": "Bo"},
    "chief@platform.co": {"email": "chief@platform.co", "email_verified": True,
                          "sub": "g-chief", "name": "Chief"},
}


def signin(client, email, mode="register"):
    """Walk the real /auth/google -> /auth/google/callback flow with mocked claims.

    Either mode creates the profile if this e-mail is new (as a pending
    approval request); a returning account simply signs in.
    Leaves the session signed in as ``email`` (a fresh session, so we also set the
    CSRF token the way the first template render would).
    """
    with mock.patch("routes.auth.exchange_and_verify",
                    return_value=CLAIMS.get(email, {"email": email, "email_verified": True,
                                                    "sub": "g-" + email, "name": email.split("@")[0]})):
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


def auth_on(app):
    app.config["STAFF_AUTH"] = True


def uid_of(app, email):
    with app.app_context():
        return models.get_db().execute("SELECT id FROM users WHERE email=?",
                                       (email,)).fetchone()["id"]


def approve_direct(app, email):
    """Grant access without walking the console (used when a test needs an
    approved account as its setup, not as its subject)."""
    import core.accounts as accounts
    with app.app_context():
        accounts.set_status(uid_of(app, email), "approved", approved_by="test")


def make_study(client, title, headers=None):
    r = client.post("/api/studio/save", json={"title": title, "cfg": CFG}, headers=headers or {})
    assert r.status_code == 200, r.get_json()
    return r.get_json()["slug"]


# ------------------------------------------------------------------ the Google flow
def test_first_google_signin_creates_one_pending_profile(app, client):
    loc = signin(client, "ana@research.co")
    assert "/welcome" in loc                                  # live status page, awaiting approval
    me = client.get("/api/me").get_json()
    assert me["user"]["email"] == "ana@research.co" and me["user"]["status"] == "pending"
    # the Kart starts empty; 100 pts are promised and land at approval time
    assert me["user"]["points_limit"] == 0 and me["user"]["points_balance"] == 0
    assert me["user"]["welcome_points_pending"] == 100
    assert me["user"]["auth_source"] == "google"

    # one profile per e-mail: signing in again reuses the row, never duplicates
    signin(client, "ana@research.co")
    with app.app_context():
        n = models.get_db().execute("SELECT COUNT(*) FROM users WHERE email=?",
                                    ("ana@research.co",)).fetchone()[0]
    assert n == 1


def test_admin_emails_bootstrap_as_approved_admins(app, client):
    app.config["ADMIN_EMAILS"] = ["chief@platform.co"]
    loc = signin(client, "chief@platform.co")
    assert "/workspace/" in loc                              # straight through
    me = client.get("/api/me").get_json()
    assert me["user"]["role"] == "admin" and me["user"]["status"] == "approved"


def test_first_signin_via_login_mode_creates_an_approval_request(app, client):
    """Easy for users: the very first "Sign in with Google" (mode=login) also
    registers the person — as a pending approval request for the admin —
    instead of bouncing them to find a separate register page."""
    loc = signin(client, "stranger@research.co", mode="login")
    assert "/welcome" in loc                                  # friendly status page, not a bounce
    with app.app_context():
        db = models.get_db()
        n = db.execute("SELECT COUNT(*) FROM users WHERE email=?",
                       ("stranger@research.co",)).fetchone()[0]
        status = db.execute("SELECT status FROM users WHERE email=?",
                            ("stranger@research.co",)).fetchone()[0]
        asked = db.execute("SELECT COUNT(*) FROM audit_events "
                           "WHERE action='auth/approval-request'").fetchone()[0]
    assert n == 1 and status == "pending" and asked == 1      # the admin has a request to review
    me = client.get("/api/me").get_json()["user"]
    assert me["email"] == "stranger@research.co" and me["welcome_points_pending"] == 100


def test_register_mode_on_an_existing_email_just_signs_in(app, client):
    signin(client, "ana@research.co", mode="register")
    loc = signin(client, "ana@research.co", mode="register")     # already registered
    assert "/welcome" in loc                                     # still pending, no duplicate
    with app.app_context():
        n = models.get_db().execute("SELECT COUNT(*) FROM users WHERE email=?",
                                    ("ana@research.co",)).fetchone()[0]
    assert n == 1
    # and an approved account registering again lands in the workspace
    approve_direct(app, "ana@research.co")
    loc = signin(client, "ana@research.co", mode="register")
    assert "/workspace/" in loc


def test_login_mode_still_bootstraps_admin_emails(app, client):
    app.config["ADMIN_EMAILS"] = ["chief@platform.co"]
    loc = signin(client, "chief@platform.co", mode="login")
    assert "/workspace/" in loc                                  # admin cannot be locked out
    assert client.get("/api/me").get_json()["user"]["role"] == "admin"


def test_user_identity_is_masked_on_user_pages_but_remains_in_admin_views(app, client):
    signin(client, "ana@research.co")
    me = client.get("/api/me").get_json()["user"]
    assert me["name"] == "Ana" and me["email_masked"] == "axxx@research.co"
    welcome = client.get("/welcome").data.decode()
    assert "axxx@research.co" in welcome and "ana@research.co" not in welcome
    landing = client.get("/").data.decode()
    assert "ana@research.co" not in landing
    js = client.get("/static/js/landing.js").data.decode()
    assert "accountLabel(me.user)" in js and "esc(me.user.email)" not in js
    assert "Use a different account" in js and "Sign out" in js
    from routes.auth import masked_email
    assert masked_email("sarah@gmail.com") == "sxxx@gmail.com"


def test_signin_register_and_recover_pages_exist(app, client):
    auth_on(app)                                   # the Google buttons render with the gate on
    for path in ("/signin", "/register", "/recover"):
        assert client.get(path).status_code == 200, path
    assert b"Register with Google" in client.get("/register").data
    assert b"Sign in with Google" in client.get("/signin").data
    assert b"Google Account Recovery" in client.get("/recover").data


def test_recover_lookup_tells_you_where_your_account_stands(app, client):
    signin(client, "ana@research.co")                            # pending
    out(client)
    r = client.post("/api/auth/recover", json={"email": "ana@research.co"})
    assert r.get_json()["found"] is True and r.get_json()["status"] == "pending"
    r = client.post("/api/auth/recover", json={"email": "ghost@research.co"})
    assert r.get_json()["found"] is False and "register" in r.get_json()["message"].lower()
    # a bare word is a username lookup, not a typo'd address; only an empty one is refused
    assert client.post("/api/auth/recover", json={"email": "nonsense"}).status_code == 200
    assert client.post("/api/auth/recover", json={"email": ""}).status_code == 400


def test_forged_oauth_state_is_refused(client):
    signin(client, "ana@research.co")
    with mock.patch("routes.auth.exchange_and_verify", return_value=CLAIMS["ana@research.co"]):
        r = client.get("/auth/google/callback", query_string={"state": "forged", "code": "x"})
        assert r.status_code == 403


# ------------------------------------------------------------------ approval gates
def test_pending_accounts_cannot_use_the_team_apps(app, client):
    auth_on(app)
    signin(client, "ana@research.co")
    assert client.get("/api/studio/list").get_json() == {
        "error": "Your account is waiting for admin approval."}
    assert "/welcome" in client.get("/studio/").headers["Location"]


def test_admin_decisions_open_and_close_access(app, client):
    auth_on(app)
    app.config["ADMIN_EMAILS"] = ["chief@platform.co"]
    signin(client, "ana@research.co")                        # creates the pending profile
    signin(client, "chief@platform.co")                      # admin session
    uid = uid_of(app, "ana@research.co")

    client.post("/api/admin/console/decision", json={"user_id": uid, "decision": "approve"}, headers=H())
    signin(client, "ana@research.co")
    assert client.get("/api/me").get_json()["user"]["status"] == "approved"
    assert client.get("/api/studio/list").status_code == 200

    signin(client, "chief@platform.co")
    client.post("/api/admin/console/decision", json={"user_id": uid, "decision": "disable"}, headers=H())
    signin(client, "ana@research.co")
    assert client.get("/api/studio/list").get_json() == {
        "error": "This account has been disabled by the platform admin."}

    signin(client, "chief@platform.co")
    client.post("/api/admin/console/decision", json={"user_id": uid, "decision": "enable"}, headers=H())
    signin(client, "ana@research.co")
    assert client.get("/api/studio/list").status_code == 200


def test_real_fieldwork_stays_public_when_auth_is_on(app, client):
    """Respondents never sign in: live survey links keep working with the gate up."""
    auth_on(app)
    app.config["ADMIN_EMAILS"] = ["chief@platform.co"]
    signin(client, "chief@platform.co")
    slug = make_study(client, "Field study", H())
    assert client.post("/api/studio/status",
                       json={"slug": slug, "status": "live"}, headers=H()).status_code == 200
    out(client)                                               # anonymous respondent
    assert client.get(f"/survey/{slug}").status_code == 200
    assert client.post("/api/start", json={"study": slug}).status_code == 200


# ------------------------------------------------------------------ project scoping
def test_projects_are_private_to_their_account(app, client):
    auth_on(app)
    signin(client, "ana@research.co")
    approve_direct(app, "ana@research.co")
    signin(client, "bo@research.co")
    approve_direct(app, "bo@research.co")
    signin(client, "ana@research.co")
    slug_a = make_study(client, "Ana study", H())
    out(client)

    signin(client, "bo@research.co")
    slug_b = make_study(client, "Bo study", H())
    assert {s["slug"] for s in client.get("/api/studio/list").get_json()} == {slug_b}
    # Bo cannot read or overwrite Ana's project
    assert client.get("/api/studio/study", query_string={"slug": slug_a}).status_code == 403
    r = client.post("/api/studio/save", json={"slug": slug_a, "title": "hijack", "cfg": CFG}, headers=H())
    assert r.status_code == 403

    # the admin sees everything
    out(client)
    app.config["ADMIN_EMAILS"] = ["chief@platform.co"]
    signin(client, "chief@platform.co")
    visible = {s["slug"] for s in client.get("/api/studio/list").get_json()}
    assert {slug_a, slug_b} <= visible                      # plus legacy unowned studies


def test_creating_a_study_stamps_the_owner(app, client):
    auth_on(app)
    signin(client, "ana@research.co")
    approve_direct(app, "ana@research.co")
    slug = make_study(client, "Owned", H())
    with app.app_context():
        row = models.get_db().execute(
            "SELECT s.owner_id AS o FROM studies s WHERE slug=?", (slug,)).fetchone()
        u = models.get_db().execute("SELECT id FROM users WHERE email=?",
                                    ("ana@research.co",)).fetchone()
    assert row["o"] == u["id"]


# ------------------------------------------------------------------ admin console
def test_console_manages_people_and_shows_their_projects(app, client):
    auth_on(app)
    app.config["ADMIN_EMAILS"] = ["chief@platform.co"]
    signin(client, "ana@research.co")                        # pending profile in the list
    signin(client, "chief@platform.co")

    ov = client.get("/api/admin/console/overview").get_json()
    assert ov["stats"]["pending"] >= 1 and any(u["email"] == "ana@research.co" for u in ov["users"])
    uid = uid_of(app, "ana@research.co")

    # a regular account cannot run the console
    out(client)
    signin(client, "bo@research.co")
    assert client.get("/api/admin/console/overview").status_code == 403
    out(client)
    signin(client, "chief@platform.co")

    r = client.post("/api/admin/console/decision",
                    json={"user_id": uid, "decision": "approve"}, headers=H())
    assert r.get_json()["ok"] and r.get_json()["user"]["status"] == "approved"
    r = client.post("/api/admin/console/decision",
                    json={"user_id": uid, "decision": "reject"}, headers=H())
    assert r.get_json()["user"]["status"] == "rejected"

    # admin can see what an account has built
    client.post("/api/admin/console/decision", json={"user_id": uid, "decision": "enable"}, headers=H())
    out(client)
    signin(client, "ana@research.co")
    make_study(client, "Ana work", H())
    out(client)
    signin(client, "chief@platform.co")
    projects = client.get("/api/admin/console/projects",
                          query_string={"user_id": uid}).get_json()["projects"]
    assert [p["title"] for p in projects] == ["Ana work"]

    # role management, with a floor: the last admin stays an admin
    chief_id = uid_of(app, "chief@platform.co")
    r = client.post("/api/admin/console/role", json={"user_id": chief_id, "role": "user"}, headers=H())
    assert r.status_code == 400
    r = client.post("/api/admin/console/role", json={"user_id": uid, "role": "admin"}, headers=H())
    assert r.get_json()["user"]["role"] == "admin"
    # with two admins aboard, one may step down
    r = client.post("/api/admin/console/role", json={"user_id": chief_id, "role": "user"}, headers=H())
    assert r.status_code == 200


def test_console_page_requires_an_admin(app, client):
    auth_on(app)
    signin(client, "ana@research.co")
    approve_direct(app, "ana@research.co")
    assert client.get("/admin/console").status_code == 403
    out(client)
    app.config["ADMIN_EMAILS"] = ["chief@platform.co"]
    signin(client, "chief@platform.co")
    r = client.get("/admin/console")
    assert r.status_code == 200 and b"Admin console" in r.data


# ------------------------------------------------------------------ admin portal
def test_admin_portal_is_protected_for_admin_and_tracks_activity(app, client):
    """Protected Admin Portal: requires Admin credentials and renders live usage & Kart data."""
    auth_on(app)
    app.config["ADMIN_EMAILS"] = ["chief@platform.co"]
    signin(client, "ana@research.co")
    approve_direct(app, "ana@research.co")
    signin(client, "ana@research.co")            # a fresh sign-in lands in the audit log
    make_study(client, "Portal watched", H())    # and so does a write
    assert client.get("/admin-portal").status_code == 403   # regular user cannot access

    out(client)                                  # anonymous visitor -> the separate Admin Login
    r_anon = client.get("/admin-portal")
    assert r_anon.status_code == 302 and "/admin-login" in r_anon.headers["Location"]

    signin(client, "chief@platform.co")
    r = client.get("/admin-portal")
    assert r.status_code == 200
    html = r.data
    for needle in (b"Usage, Kart Points &amp; Activity", b"ana@research.co",
                   b"Activity feed", b"Protected", b"All SurveyKart users"):
        assert needle in html, needle
    assert b"Signed in" in html or b"Edited a design" in html   # audit trail humanised


# ------------------------------------------------------------------ admin oversight
def test_admin_edits_and_manages_any_users_project(app, client):
    """The admin is the platform owner: full read + edit on every account's work."""
    auth_on(app)
    app.config["ADMIN_EMAILS"] = ["chief@platform.co"]
    signin(client, "ana@research.co")
    approve_direct(app, "ana@research.co")
    signin(client, "ana@research.co")
    slug = make_study(client, "Ana's study", H())
    out(client)

    signin(client, "chief@platform.co")
    # whole studio is visible: open it, read it, overwrite the design
    r = client.get("/api/studio/study", query_string={"slug": slug})
    assert r.status_code == 200
    assert r.get_json()["owner_email"] == "ana@research.co"
    cfg = r.get_json()["cfg"]
    cfg["questions"][0]["stem"] = "Edited by the admin"
    r = client.post("/api/studio/save", json={"slug": slug, "title": "Ana's study", "cfg": cfg}, headers=H())
    assert r.status_code == 200
    assert client.get("/api/studio/study", query_string={"slug": slug}) \
        .get_json()["cfg"]["questions"][0]["stem"] == "Edited by the admin"
    # manage it from the back-end: status changes and delete rights included
    r = client.post("/api/studio/status", json={"slug": slug, "status": "live"}, headers=H())
    assert r.status_code == 200
    assert client.get("/api/studio/study", query_string={"slug": slug}).get_json()["status"] == "live"


def test_admin_can_take_and_give_ownership_from_the_console(app, client):
    auth_on(app)
    app.config["ADMIN_EMAILS"] = ["chief@platform.co"]
    signin(client, "ana@research.co")
    approve_direct(app, "ana@research.co")
    signin(client, "ana@research.co")
    slug = make_study(client, "Handover", H())
    ana_id = uid_of(app, "ana@research.co")
    out(client)

    signin(client, "chief@platform.co")
    r = client.post("/api/admin/console/project/owner", json={"slug": slug}, headers=H())
    assert r.get_json()["owner_id"] == uid_of(app, "chief@platform.co")
    # and hand it back to the account that built it
    r = client.post("/api/admin/console/project/owner",
                    json={"slug": slug, "user_id": ana_id}, headers=H())
    assert r.get_json()["owner_id"] == ana_id
    assert client.post("/api/admin/console/project/owner",
                       json={"slug": "nope"}, headers=H()).status_code == 404

    # non-admins cannot re-own other people's work
    out(client)
    signin(client, "bo@research.co")
    approve_direct(app, "bo@research.co")
    signin(client, "bo@research.co")
    assert client.post("/api/admin/console/project/owner",
                       json={"slug": slug}, headers=H()).status_code == 403


# ------------------------------------------------------------------ dev sign-in
def test_dev_login_exists_only_when_explicitly_enabled(app, client):
    assert client.post("/auth/dev", json={"email": "x@y.co"}).status_code == 404
    app.config["DEV_LOGIN"] = True
    # mirrors Google: a first dev sign-in (either mode) creates a pending
    # approval request; the response points at the live status page
    r = client.post("/auth/dev", json={"email": "dev@local.test", "name": "Dev", "mode": "login"})
    assert r.status_code == 200 and r.get_json()["user"]["status"] == "pending"
    assert r.get_json()["redirect"] == "/welcome"
    r = client.post("/auth/dev", json={"email": "dev@local.test", "name": "Dev", "mode": "register"})
    assert r.status_code == 200 and r.get_json()["user"]["email"] == "dev@local.test"
    # structurally impossible in production, whatever the environment says
    from config import Config
    assert not (Config.PRODUCTION and Config.DEV_LOGIN)


# ------------------------------------------------------------------ approval + 100 Kart pts
def _welcome_txs(app, email):
    with app.app_context():
        return [dict(r) for r in models.get_db().execute(
            "SELECT pt.* FROM point_transactions pt JOIN users u ON u.id=pt.user_id "
            "WHERE u.email=? AND pt.reason LIKE 'Welcome allocation%' ORDER BY pt.id",
            (email,)).fetchall()]


def test_admin_approval_adds_exactly_100_kart_points_once(app, client):
    auth_on(app)
    app.config["ADMIN_EMAILS"] = ["chief@platform.co"]
    signin(client, "ana@research.co", mode="login")           # pending, empty Kart
    assert _welcome_txs(app, "ana@research.co") == []          # nothing granted yet
    signin(client, "chief@platform.co")                       # admin session
    uid = uid_of(app, "ana@research.co")

    # the console shows the pending request with its promised points
    ov = client.get("/api/admin/console/overview").get_json()
    ana_row = next(u for u in ov["users"] if u["email"] == "ana@research.co")
    assert ana_row["welcome_points_pending"] == 100 and ana_row["points_limit"] == 0

    r = client.post("/api/admin/console/decision",
                    json={"user_id": uid, "decision": "approve"}, headers=H())
    out = r.get_json()
    assert out["ok"] and out["welcome_points_granted"] == 100
    assert out["user"]["points_limit"] == 100 and out["user"]["points_balance"] == 100
    txs = _welcome_txs(app, "ana@research.co")
    assert len(txs) == 1 and txs[0]["delta"] == 100 and txs[0]["balance_after"] == 100

    # the user now sees the points in their Kart
    signin(client, "ana@research.co", mode="login")
    me = client.get("/api/me").get_json()["user"]
    assert me["status"] == "approved" and me["points_balance"] == 100
    assert me["welcome_points_pending"] == 0

    # disable -> re-enable must never grant the welcome points twice
    signin(client, "chief@platform.co")
    client.post("/api/admin/console/decision", json={"user_id": uid, "decision": "disable"}, headers=H())
    r = client.post("/api/admin/console/decision", json={"user_id": uid, "decision": "enable"}, headers=H())
    assert r.get_json()["welcome_points_granted"] == 0
    assert r.get_json()["user"]["points_limit"] == 100
    assert len(_welcome_txs(app, "ana@research.co")) == 1


def test_admin_can_choose_welcome_points_while_approving(app, client):
    auth_on(app)
    app.config["ADMIN_EMAILS"] = ["chief@platform.co"]
    signin(client, "bo@research.co", mode="login")
    signin(client, "chief@platform.co")
    uid = uid_of(app, "bo@research.co")
    r = client.post("/api/admin/console/decision",
                    json={"user_id": uid, "decision": "approve", "points": 250}, headers=H())
    assert r.get_json()["welcome_points_granted"] == 250
    assert r.get_json()["user"]["points_limit"] == 250


def test_legacy_pending_account_keeps_its_100_without_a_double_grant(app, client):
    """Accounts created under the old rules already hold 100 pts + a welcome
    ledger row; approving them must not top them up to 200."""
    auth_on(app)
    app.config["ADMIN_EMAILS"] = ["chief@platform.co"]
    signin(client, "ana@research.co", mode="login")
    with app.app_context():
        db = models.get_db()
        uid = uid_of(app, "ana@research.co")
        with db:
            db.execute("UPDATE users SET points_limit=100 WHERE id=?", (uid,))
            db.execute(
                "INSERT INTO point_transactions (user_id, delta, balance_after, reason, actor, created_at) "
                "VALUES (?,?,?,?,?,?)",
                (uid, 100, 100, "Welcome allocation on SurveyKart registration (100 pts)",
                 "system", "2026-01-01T00:00:00"))
    signin(client, "chief@platform.co")
    r = client.post("/api/admin/console/decision",
                    json={"user_id": uid, "decision": "approve"}, headers=H())
    assert r.get_json()["welcome_points_granted"] == 0
    assert r.get_json()["user"]["points_limit"] == 100
    assert len(_welcome_txs(app, "ana@research.co")) == 1


def test_fresh_google_signup_notifies_admins_once(app, client):
    with mock.patch("core.accounts.notify_admins_pending_signup") as notify:
        signin(client, "ana@research.co", mode="login")
        assert notify.call_count == 1
        # signing in again while still pending does not spam the admin
        signin(client, "ana@research.co", mode="login")
        assert notify.call_count == 1


def test_notify_helpers_send_only_when_smtp_is_configured(app):
    import core.accounts as accounts
    app.config["ADMIN_EMAILS"] = ["chief@platform.co"]
    pending = {"email": "ana@research.co", "name": "Ana", "status": "pending",
               "google_sub": "g-ana", "created_at": "2026-10-24T10:00:00"}
    with app.app_context():
        with mock.patch("core.mailer.smtp_settings", return_value=None):
            assert accounts.notify_admins_pending_signup(pending) is False
        sent = []
        with mock.patch("core.mailer.smtp_settings", return_value={"host": "smtp.test"}), \
                mock.patch("core.mailer.send_mail", side_effect=lambda *a: sent.append(a)):
            assert accounts.notify_admins_pending_signup(pending) is True
            approved = dict(pending, status="approved")
            assert accounts.notify_user_approved(approved, 100) is True
    assert [s[0] for s in sent] == ["chief@platform.co", "ana@research.co"]
    assert "approval" in sent[0][1].lower() and "100" in sent[1][2]


# ------------------------------------------------------------------ the /welcome status page
def test_welcome_page_shows_each_account_state(app, client):
    auth_on(app)
    app.config["ADMIN_EMAILS"] = ["chief@platform.co"]
    out(client)
    assert client.get("/welcome").status_code == 302           # signed-out -> sign in first

    signin(client, "ana@research.co", mode="login")
    html = client.get("/welcome").data.decode()
    assert "approval request has been sent" in html            # pending: request is with the admin
    assert "axxx@research.co" in html and "ana@research.co" not in html and "100 Kart points" in html
    assert "up to 24 hours" in html and "email you" in html.lower()
    assert "Check status now" not in html

    approve_direct(app, "ana@research.co")                     # set_status grants the 100 too
    html = client.get("/welcome").data.decode()
    assert "Welcome to SurveyKart" in html and "100 Kart points" in html
    assert 'href="/workspace/"' in html

    # rejected accounts get a clear explanation instead of a dead end
    signin(client, "bo@research.co", mode="login")
    signin(client, "chief@platform.co")
    client.post("/api/admin/console/decision",
                json={"user_id": uid_of(app, "bo@research.co"), "decision": "reject"}, headers=H())
    loc = signin(client, "bo@research.co", mode="login")
    assert "/welcome" in loc
    html = client.get("/welcome").data.decode()
    assert "wasn't approved" in html

    # legacy pending landing URL forwards to the real status page
    assert "/welcome" in client.get("/?welcome=1").headers["Location"]


def test_google_unconfigured_is_a_friendly_detour_not_an_error_page(app, client):
    app.config["GOOGLE_CLIENT_ID"] = ""
    app.config["STAFF_AUTH"] = True
    r = client.get("/auth/google", query_string={"mode": "login"})
    assert r.status_code == 302 and "notice=google-off" in r.headers["Location"]
    html = client.get(r.headers["Location"]).data.decode()
    assert "Google sign-in isn't switched on yet" in html
