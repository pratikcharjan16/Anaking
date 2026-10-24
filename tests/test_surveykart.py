"""End-to-end tests for SurveyKart:
  1. Protected Admin & Studio access (environment-configured credentials) + 3D visible Admin nav
  2. SurveyKart rebrand ("Insights Delivered") & 3D animated GIF logo button on every page
  3. 100-pt default Kart allocation, 13-type point catalog, 70-pt shopping deduction,
     multi-project balance & Admin point adjustments / request approvals
  4. Zero-debit single-link collaboration (registration required first) & respondent survey links
"""

from __future__ import annotations

import os
import re

from core.kart import KART_CATALOG, QUESTION_POINTS


def _csrf(client) -> str:
    r = client.get("/signin")
    m = re.search(rb'name="csrf-token"\s+content="([^"]+)"', r.data)
    return m.group(1).decode() if m else ""


def _h(client) -> dict:
    tok = _csrf(client)
    return {"X-CSRF-Token": tok} if tok else {}


def _sample_70pt_cfg(title: str = "Oncology Switching Kart Study") -> dict:
    """2 Single select (20) + 1 Constant sum (20) + 1 Delta question (30) = 70 Kart points."""
    return {
        "title": title,
        "sections": [{"id": "S1", "title": "Main", "blurb": None}],
        "questions": [
            {"id": "Q1", "section": "S1", "type": "single_select", "required": True,
             "stem": "Primary specialty",
             "options": [{"code": 1, "label": "Medical Onc"}, {"code": 2, "label": "Hem Onc"}]},
            {"id": "Q2", "section": "S1", "type": "single_select", "required": True,
             "stem": "Practice setting",
             "options": [{"code": 1, "label": "Academic"}, {"code": 2, "label": "Community"}]},
            {"id": "Q3", "section": "S1", "type": "sum_to_100", "required": True,
             "stem": "Allocate 100% across regimens",
             "rows": [{"code": "a", "label": "Regimen A"}, {"code": "b", "label": "Regimen B"}]},
            {"id": "Q4", "section": "S1", "type": "delta", "required": True,
             "source_question": "Q3",
             "stem": "How would that allocation shift next year?",
             "rows": [{"code": "a", "label": "Regimen A"}, {"code": "b", "label": "Regimen B"}],
             "cols": [{"code": "c1", "label": "Future %"}]},
        ],
    }


def test_question_library_point_catalog_matches_specification(client):
    expected_by_type = {
        "single_select": 10,
        "multi_select": 15,
        "rank": 15,
        "rating_grid": 20,
        "numeric_matrix": 20,
        "text_grid": 25,
        "rating_scale": 20,
        "gauge_meter": 10,
        "semantic_diff": 15,
        "emoji_grid": 15,
        "numeric": 15,
        "open_text": 15,
        "slider": 15,
        "sum_to_100": 20,
        "date": 10,
        "delta": 30,
        "concept_test": 30,
        "heatmap": 30,
        "walk_through": 40,
        "maxdiff": 35,
        "choice_task": 40,
        "loop": 25,
        "text_block": 0,
    }
    by_type = {item["type"]: item["points"] for item in KART_CATALOG}
    assert len(KART_CATALOG) == 23
    assert by_type == expected_by_type
    assert QUESTION_POINTS == expected_by_type

    r = client.get("/api/kart/catalog")
    assert r.status_code == 200
    assert r.get_json()["default_points"] == 100
    assert len(r.get_json()["catalog"]) == 23


def test_master_admin_credentials_protect_studio_and_admin_surfaces(app, client):
    app.config["STAFF_AUTH"] = True
    app.config["WORKSPACE_ENABLED"] = True

    # Signed-out visitors cannot enter Studio, Monitor, Admin Console, or Admin Portal.
    # Team apps use the regular sign-in; admin surfaces get the separate Admin Login.
    for protected in ("/studio/", "/admin/", "/admin/console", "/admin-portal", "/workspace/"):
        resp = client.get(protected)
        assert resp.status_code == 302, protected
        door = "/admin-login" if protected in ("/admin/console", "/admin-portal") else "/signin"
        assert door in resp.headers["Location"], protected

    # Wrong password for Anaking.admin is rejected
    bad = client.post("/api/auth/login", headers=_h(client),
                      json={"identifier": "Anaking.admin", "password": "wrong-password"})
    assert bad.status_code == 401

    # Master Admin logs in with the test-only environment-configured password.
    ok = client.post("/api/auth/login", headers=_h(client),
                     json={"identifier": "Anaking.admin", "password": os.environ["ADMIN_PASSWORD"],
                           "next": "/studio/"})
    assert ok.status_code == 200, ok.get_json()
    payload = ok.get_json()
    assert payload["user"]["role"] == "admin"
    assert payload["user"]["is_protected"] is True

    # Master Admin can access Studio, Monitor, Admin Console, Admin Portal, Workspace
    for surface in ("/studio/", "/admin/", "/admin/console", "/admin-portal", "/workspace/"):
        resp = client.get(surface)
        assert resp.status_code == 200, surface

    # Master Admin account cannot be disabled or demoted
    uid = payload["user"]["id"]
    demote = client.post("/api/admin/console/role", headers=_h(client),
                         json={"user_id": uid, "role": "user"})
    assert demote.status_code == 400
    disable = client.post("/api/admin/console/decision", headers=_h(client),
                          json={"user_id": uid, "decision": "disable"})
    assert disable.status_code == 400


def test_rebrand_3d_animated_logo_button_and_visible_3d_admin_nav(app, client):
    app.config["STAFF_AUTH"] = True
    app.config["WORKSPACE_ENABLED"] = True

    # Check GIF assets exist and are valid animated GIF89a files
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    for gif_name in ("surveykart-3d-logo.gif", "surveykart-kart-demo.gif"):
        p = os.path.join(root, "static", "images", gif_name)
        assert os.path.isfile(p)
        with open(p, "rb") as fh:
            assert fh.read(6) == b"GIF89a"

    # Landing page has 3D logo button + animated Kart point demo section
    landing_html = client.get("/").data.decode()
    assert "SurveyKart" in landing_html
    assert "Insights Delivered" in landing_html
    assert "surveykart-3d-logo.gif" in landing_html
    assert "surveykart-kart-demo.gif" in landing_html
    assert 'id="kart-demo"' in landing_html

    # Sign in as Master Admin and verify every page has the clickable 3D logo button -> "/"
    client.post("/api/auth/login", headers=_h(client),
                json={"identifier": "Anaking.admin", "password": os.environ["ADMIN_PASSWORD"]})
    for page in ("/", "/signin", "/register", "/studio/", "/admin/", "/admin/console",
                 "/admin-portal", "/workspace/", "/survey/", "/survey/test"):
        html = client.get(page).data.decode()
        assert "SurveyKart" in html, page
        assert "surveykart-3d-logo.gif" in html, page
        assert 'sk-brand-3d-btn' in html, page
        assert 'href="/"' in html, page

    # Verify nav.css fixes the previously invisible Admin Portal navigation buttons
    nav_css = open(os.path.join(root, "static", "css", "nav.css"), encoding="utf-8").read()
    assert "body.landing .appnav-link" in nav_css
    assert "body.portal .appnav-link" in nav_css


def test_100pt_registration_70pt_shopping_deduction_and_admin_point_allocation(app, client, approve):
    app.config["STAFF_AUTH"] = True

    # 1. Register with a username + password -> an approval request, 0 Kart points yet
    reg = client.post("/api/auth/register", headers=_h(client), json={
        "name": "Priya Nair",
        "email": "priya@clinic.in",
        "username": "priya.nair",
        "password": "secret123",
    })
    assert reg.status_code == 200, reg.get_json()
    data = reg.get_json()
    priya_id = data["user"]["id"]
    assert data["pending"] is True and data["status"] == "pending"
    assert data["redirect"] == "/welcome"
    assert data["user"]["points_limit"] == 0
    assert client.get("/studio/").headers["Location"].endswith("/welcome")

    # The admin grants access -> the 100 Kart points land in the same click
    approve("priya@clinic.in")
    with app.app_context():
        from core.kart import user_kart_summary
        kart = user_kart_summary(priya_id)
    assert kart["points_limit"] == 100
    assert kart["points_used"] == 0
    assert kart["points_balance"] == 100

    # Regular user cannot access Admin Console or Admin Portal
    assert client.get("/admin/console").status_code == 403
    assert client.get("/admin-portal").status_code == 403

    # 2. Create Project 1 with 2 Single Select (20) + 1 Constant Sum (20) + 1 Delta (30) = 70 pts
    s1 = client.post("/api/studio/save", headers=_h(client), json={
        "slug": "",
        "title": "Project One (70 pts)",
        "cfg": _sample_70pt_cfg("Project One (70 pts)"),
    })
    assert s1.status_code == 200, s1.get_json()
    kart_after_p1 = s1.get_json()["kart"]
    assert kart_after_p1["points_used"] == 70
    assert kart_after_p1["points_balance"] == 30

    # 3. Create Project 2 using the remaining 30 balance points (3 Single Select = 30 pts)
    cfg2 = {
        "title": "Project Two (30 pts)",
        "sections": [{"id": "S1", "title": "Main", "blurb": None}],
        "questions": [
            {"id": f"Q{i}", "section": "S1", "type": "single_select", "required": True,
             "stem": f"Question {i}", "options": [{"code": 1, "label": "Yes"}, {"code": 2, "label": "No"}]}
            for i in (1, 2, 3)
        ],
    }
    s2 = client.post("/api/studio/save", headers=_h(client), json={"slug": "", "title": cfg2["title"], "cfg": cfg2})
    assert s2.status_code == 200, s2.get_json()
    assert s2.get_json()["kart"]["points_used"] == 100
    assert s2.get_json()["kart"]["points_balance"] == 0

    # 4. Creating a 3rd project when 0 balance remains is blocked (HTTP 402)
    cfg3 = {
        "title": "Project Three (40 pts Conjoint)",
        "sections": [{"id": "S1", "title": "Main", "blurb": None}],
        "questions": [{"id": "Q1", "section": "S1", "type": "choice_task", "required": True, "stem": "Pick one"}],
    }
    s3_blocked = client.post("/api/studio/save", headers=_h(client), json={"slug": "", "title": cfg3["title"], "cfg": cfg3})
    assert s3_blocked.status_code == 402
    assert "Not enough SurveyKart points" in s3_blocked.get_json()["error"]

    # 5. User requests +60 Kart points from Admin
    req = client.post("/api/kart/request-points", headers=_h(client),
                      json={"requested_points": 60, "reason": "Need Conjoint for Project Three"})
    assert req.status_code == 200
    req_id = req.get_json()["request"]["id"]

    # 6. Admin signs in, approves the request (+60 -> limit 160), and tests decreasing (-10 -> limit 150)
    client.post("/auth/logout", headers=_h(client))
    client.post("/api/auth/login", headers=_h(client),
                json={"identifier": "Anaking.admin", "password": os.environ["ADMIN_PASSWORD"]})
    dec = client.post("/api/admin/console/point-requests/decide", headers=_h(client),
                      json={"request_id": req_id, "decision": "approve"})
    assert dec.status_code == 200
    assert dec.get_json()["request"]["new_points_limit"] == 160

    adj = client.post("/api/admin/console/points", headers=_h(client),
                      json={"user_id": priya_id, "delta": -10, "reason": "Trim to 150"})
    assert adj.status_code == 200
    assert adj.get_json()["user"]["points_limit"] == 150
    assert adj.get_json()["user"]["points_balance"] == 50

    # 7. User signs back in and creates Project 3 (40 pts) -> 140/150 used, 10 balance left!
    client.post("/auth/logout", headers=_h(client))
    client.post("/api/auth/login", headers=_h(client),
                json={"identifier": "priya.nair", "password": "secret123"})
    s3_ok = client.post("/api/studio/save", headers=_h(client), json={"slug": "", "title": cfg3["title"], "cfg": cfg3})
    assert s3_ok.status_code == 200, s3_ok.get_json()
    assert s3_ok.get_json()["kart"]["points_used"] == 140
    assert s3_ok.get_json()["kart"]["points_balance"] == 10


def test_shared_collaboration_and_respondent_links_debit_zero_points(app, client, approve):
    app.config["STAFF_AUTH"] = True

    # Owner registers (approval request), the admin approves -> 100 pts, 70-pt study goes live
    client.post("/api/auth/register", headers=_h(client), json={
        "name": "Owner One", "email": "owner@surveykart.co", "password": "password123"
    })
    approve("owner@surveykart.co")
    client.post("/api/auth/login", headers=_h(client),
                json={"identifier": "owner@surveykart.co", "password": "password123"})
    s = client.post("/api/studio/save", headers=_h(client), json={
        "slug": "shared-kart-study",
        "title": "Shared Kart Study",
        "cfg": _sample_70pt_cfg("Shared Kart Study"),
    })
    assert s.status_code == 200
    slug = s.get_json()["slug"]
    client.post("/api/studio/status", headers=_h(client), json={"slug": slug, "status": "live"})

    # Owner generates a single-link collaboration invite
    sh = client.post("/api/studio/share", headers=_h(client), json={
        "slug": slug, "email": "collab@surveykart.co", "permission": "collaborate"
    })
    assert sh.status_code == 200
    share_token = sh.get_json()["share"]["token"]
    assert sh.get_json()["share"]["points_debited"] == 0

    # Sign out -> New user opens /share/<token> -> asked to register first!
    client.post("/auth/logout", headers=_h(client))
    gate = client.get(f"/share/{share_token}")
    assert gate.status_code == 302
    assert f"/register?share={share_token}" in gate.headers["Location"]
    reg_page = client.get(gate.headers["Location"]).data.decode()
    assert "0 Kart Points Debited" in reg_page
    assert "Shared Kart Study" in reg_page

    # New user registers with the share token -> link attaches to account, 0 points debited!
    reg2 = client.post("/api/auth/register", headers=_h(client), json={
        "name": "Collaborator Two",
        "email": "collab@surveykart.co",
        "password": "password456",
        "share_token": share_token,
    })
    assert reg2.status_code == 200, reg2.get_json()
    reg2_json = reg2.get_json()
    # A new account is an approval request: it waits on /welcome, the shared link
    # is remembered, and approving it lands the 100 pts and opens the study.
    assert reg2_json["pending"] is True
    assert reg2_json["redirect"] == "/welcome"
    approve("collab@surveykart.co")
    client.post("/api/auth/login", headers=_h(client),
                json={"identifier": "collab@surveykart.co", "password": "password456"})
    assert client.get("/api/kart/me").get_json()["kart"]["points_limit"] == 100

    # Collaborator sees the shared study in Studio and can open & co-edit the single link at 0 pt cost!
    st_list = client.get("/api/studio/list").get_json()
    shared_entry = next(x for x in st_list if x["slug"] == slug)
    assert shared_entry["is_shared"] is True
    assert shared_entry["points_debited"] == 0

    study_doc = client.get(f"/api/studio/study?slug={slug}").get_json()
    assert study_doc["is_shared"] is True
    updated_cfg = study_doc["cfg"]
    updated_cfg["questions"][0]["stem"] = "Primary specialty (reviewed by collaborator)"
    co_save = client.post("/api/studio/save", headers=_h(client),
                          json={"slug": slug, "title": "Shared Kart Study", "cfg": updated_cfg})
    assert co_save.status_code == 200, co_save.get_json()

    # Verify Collaborator STILL has 0 points used (full 100 balance intact!)
    kart_me = client.get("/api/kart/me").get_json()["kart"]
    assert kart_me["points_used"] == 0
    assert kart_me["points_balance"] == 100

    # Sign out -> Anonymous respondent opens the shared survey link to fill out the survey -> 0 pts debited!
    client.post("/auth/logout", headers=_h(client))
    survey_page = client.get(f"/survey/{slug}")
    assert survey_page.status_code == 200
    start = client.post("/api/start", json={"study": slug, "is_test": False})
    assert start.status_code == 200
    sid = start.get_json()["session_id"]
    save_ans = client.post("/api/save", json={
        "session_id": sid,
        "answers": {"Q1": 1, "Q2": 1, "Q3": {"a": 60, "b": 40}, "Q4": {"a": {"c1": 70}, "b": {"c1": 30}}},
    })
    assert save_ans.status_code == 200
    sub = client.post("/api/submit", json={"session_id": sid, "elapsed_seconds": 42})
    assert sub.status_code == 200


def test_landing_insights_chart_and_ai_verbatim_xray_demo(app, client):
    """Landing page renders the fixed Insights Delivered chart and live AI open-ended detector."""
    app.config["STAFF_AUTH"] = True
    r = client.get("/")
    assert r.status_code == 200
    html = r.data.decode("utf-8")

    # 1. Fixed "Insights Delivered · Read it while it fields" chart structure
    for needle in ("dm-stage-analysis", "dd-hole", "Efficacy", "78%", "Dosing", "54%", "Safety", "31%"):
        assert needle in html, needle

    # 2. AI Open-Ended Response Detection ribbon + Forensic Verbatim X-Ray banner
    for needle in ("sk-ai-ribbon", 'id="ai-detect-demo"', 'data-ai-preset="chatgpt"',
                   'data-ai-preset="human"', 'data-ai-preset="custom"', 'id="sk-ai-arc-fill"'):
        assert needle in html, needle

    # 3. Anonymous landing-page visitor can run live /api/check_text scoring
    ai_res = client.post("/api/check_text", json={
        "qid": "Q7",
        "text": ("As an AI language model, switching first-line oncology therapy involves a "
                 "multifaceted landscape of clinical considerations. Moreover, progression-free "
                 "survival plays a pivotal role, and it is important to note that delving into "
                 "tolerability fosters optimal outcomes in summary."),
        "meta": {"keystrokes": 0, "pasted_chars": 278, "pastes": 1, "input_events": 1, "typed_ms": 950},
    }).get_json()
    assert ai_res["ok"] is True
    assert ai_res["verdict"] == "likely_ai"
    assert ai_res["score"] >= 60

    hm_res = client.post("/api/check_text", json={
        "qid": "Q7",
        "text": ("Honestly in my practice I've switched ~30% of patients within 3 months if "
                 "grade 3 neutropenia hits or scans show early liver progression. We've found "
                 "dose holds only buy maybe 2 weeks before patients ask for an oral option."),
        "meta": {"keystrokes": 228, "pasted_chars": 0, "pastes": 0, "input_events": 224, "typed_ms": 34500},
    }).get_json()
    assert hm_res["ok"] is True
    assert hm_res["verdict"] == "human"
    assert hm_res["score"] < 35


def test_responsive_viewport_and_layout_across_desktop_browser_and_mobile(app, client):
    from pathlib import Path

    app.config["STAFF_AUTH"] = True

    # Public routes carry responsive viewport meta
    for route in ("/", "/?legacy=1", "/signin", "/register", "/recover"):
        r = client.get(route)
        assert r.status_code == 200, route
        html = r.data.decode()
        assert 'name="viewport"' in html and "width=device-width" in html, route

    # Sign in as reserved admin and check authenticated routes across Workspace, Studio, Monitor, Console, Portal & Survey
    login = client.post("/api/auth/login", headers=_h(client), json={
        "email": "Anaking.admin", "password": os.environ["ADMIN_PASSWORD"]
    })
    assert login.status_code == 200

    s = client.post("/api/studio/save", headers=_h(client), json={
        "slug": "responsive-check",
        "title": "Responsive Check",
        "cfg": _sample_70pt_cfg("Responsive Check"),
    })
    assert s.status_code == 200
    client.post("/api/studio/status", headers=_h(client), json={"slug": "responsive-check", "status": "live"})

    for route in ("/workspace", "/studio/", "/admin/", "/admin/console", "/admin-portal", "/survey/responsive-check"):
        r = client.get(route, follow_redirects=True)
        assert r.status_code == 200, route
        html = r.data.decode()
        assert 'name="viewport"' in html and "width=device-width" in html, route

    # Stylesheet layout contracts across desktop (1280px+), laptop/browser (1140px/980px), tablet (850px/820px), and mobile (640px/480px)
    css_dir = Path(app.static_folder) / "css"
    ds = (css_dir / "design-system.css").read_text()
    assert "overflow-x: clip" in ds
    assert "@media (max-width: 960px)" in ds and "@media (max-width: 640px)" in ds

    landing_css = (css_dir / "landing.css").read_text()
    assert "body.landing main{max-width:none;margin:0;padding:0}" in landing_css
    assert "min-height:186px;height:auto" in landing_css
    for bp in ("@media(max-width:1140px)", "@media(max-width:980px)", "@media(max-width:640px)", "@media(max-width:480px)"):
        assert bp in landing_css, bp

    portal_css = (css_dir / "portal.css").read_text()
    assert "body.portal main{max-width:none;margin:0;padding:0}" in portal_css
    for bp in ("@media(max-width:980px)", "@media(max-width:600px)", "@media(max-width:420px)"):
        assert bp in portal_css, bp

    studio_ws = (css_dir / "studio-workspace.css").read_text()
    assert "#st-root{max-width:none!important;padding:0!important" in studio_ws


def test_landing_straightline_rating_scale_demo_card(app, client):
    r = client.get("/")
    assert r.status_code == 200
    html = r.data.decode()

    for needle in (
        'id="straightline-demo"',
        'data-demo="straightline"',
        "Straight-Line Guard",
        "Laser Plumb-Line",
        'data-sl-preset="col4"',
        'data-sl-preset="human"',
        'data-sl-preset="diag"',
        'data-sl-preset="rush5"',
        'id="sl-vector-svg"',
        'id="sl-laser-beam"',
        'id="sl-seismo-path"',
        "straightliner_Q9",
    ):
        assert needle in html, needle
    assert html.count('class="sl-row"') == 5


def test_landing_voice_and_dictate_open_text_demo_card(app, client):
    r = client.get("/")
    assert r.status_code == 200
    html = r.data.decode()

    for needle in (
        'id="voice-open-demo"',
        'data-demo="voiceopen"',
        "Open-Text Voice Studio",
        'data-vc-preset="clinician"',
        'data-vc-preset="clip"',
        'data-vc-preset="mobile"',
        'data-vc-preset="mic"',
        'id="vc-wave-bars"',
        'id="vc-transcript-box"',
        ".tg-voice-btn",
        "POST /api/voice",
    ):
        assert needle in html, needle


def test_landing_walkthrough_responder_empathy_demo_card(app, client):
    r = client.get("/")
    assert r.status_code == 200
    html = r.data.decode()

    for needle in (
        'id="walkthrough-demo"',
        'data-wt-ch="0"',
        'data-wt-ch="1"',
        'data-wt-ch="2"',
        'data-wt-ch="3"',
        "wt-ecg-line",
        "wt-km-exp",
        'data-wt-pick="pfs"',
        'data-wt-pick="oral"',
        'data-wt-pick="care"',
    ):
        assert needle in html, needle


def test_workspace_team_creation_collaboration_account_names_points_and_changelog(app, client, approve):
    app.config["STAFF_AUTH"] = True

    # 1. Alice registers (approval request -> approved with 100 Kart pts) and creates a team +
    #    shared project, inviting Bob by his email ID (Google ID): bob.team@gmail.com
    reg_a = client.post("/api/auth/register", headers=_h(client), json={
        "name": "Alice Researcher", "email": "alice.lead@gmail.com", "password": "password123"
    })
    assert reg_a.status_code == 200
    approve("alice.lead@gmail.com")
    client.post("/api/auth/login", headers=_h(client),
                json={"identifier": "alice.lead@gmail.com", "password": "password123"})

    create_t = client.post("/api/workspace/teams/create", headers=_h(client), json={
        "team_name": "Oncology Insights Team",
        "email": "bob.team@gmail.com",
        "create_project_title": "Q4 Oncology Brand Tracker",
    })
    assert create_t.status_code == 200, create_t.get_json()
    tdata = create_t.get_json()
    assert tdata["ok"] is True
    team_id = tdata["team"]["id"]
    study_slug = tdata["study_slug"]
    share_token = tdata["share"]["token"]
    assert tdata["share"]["points_debited"] == 0

    # 2. Bob registers normally (without clicking /share/<token> yet) and logs in ->
    #    He sees the incoming collaboration request right on his Workspace (/api/workspace/projects)!
    client.post("/auth/logout", headers=_h(client))
    reg_b = client.post("/api/auth/register", headers=_h(client), json={
        "name": "Bob Teammate", "email": "bob.team@gmail.com", "password": "password123"
    })
    assert reg_b.status_code == 200
    approve("bob.team@gmail.com")
    client.post("/api/auth/login", headers=_h(client),
                json={"identifier": "bob.team@gmail.com", "password": "password123"})

    # Bob checks his Workspace (/api/workspace/projects) -> sees the incoming collaboration request!
    bob_ws_before = client.get("/api/workspace/projects").get_json()
    assert len(bob_ws_before["incoming_invites"]) == 1
    inv = bob_ws_before["incoming_invites"][0]
    assert inv["token"] == share_token
    assert inv["inviter_name"] == "Alice Researcher"
    assert inv["team_name"] == "Oncology Insights Team"

    # Also verify that if a signed-out user opens /share/<token>, it prompts them to register/sign-in
    # with Alice's Account Name and Team Name displayed on the gate banner!
    client.post("/auth/logout", headers=_h(client))
    gate = client.get(f"/share/{share_token}")
    assert gate.status_code == 302
    assert f"share={share_token}" in gate.headers["Location"]
    gate_html = client.get(gate.headers["Location"]).data.decode()
    assert "Alice Researcher" in gate_html
    assert "Oncology Insights Team" in gate_html
    assert "0 Kart Points Debited" in gate_html

    # Clear pending_share_token by logging in as Bob without share_token to test explicit Workspace accept button
    with client.session_transaction() as sess:
        sess.pop("pending_share_token", None)
    client.post("/api/auth/login", headers=_h(client), json={
        "identifier": "bob.team@gmail.com", "password": "password123"
    })

    # 3. Bob clicks to accept the invite on his Workspace (/api/workspace/teams/accept) -> Team forms!
    acc = client.post("/api/workspace/teams/accept", headers=_h(client), json={"token": share_token})
    assert acc.status_code == 200, acc.get_json()
    assert acc.get_json()["team_formed"] is True

    # 4. Bob now sees the formed team, Alice's Account Name, and the shared project on his Workspace
    #    with 0 Kart points debited from Bob!
    bob_ws_after = client.get("/api/workspace/projects").get_json()
    assert len(bob_ws_after["incoming_invites"]) == 0
    assert len(bob_ws_after["teams"]) == 1
    team_bob_view = bob_ws_after["teams"][0]
    assert team_bob_view["team_formed"] is True
    assert team_bob_view["creator_name"] == "Alice Researcher"
    member_names = {m["account_name"] for m in team_bob_view["members"]}
    assert "Alice Researcher" in member_names
    assert "Bob Teammate" in member_names

    # Bob edits the shared project in Studio (adds a 70-pt questionnaire) ->
    # Points are debited ONLY from Alice (Team Creator), 0 points debited from Bob!
    save_by_bob = client.post("/api/studio/save", headers=_h(client), json={
        "slug": study_slug,
        "title": "Q4 Oncology Brand Tracker",
        "cfg": _sample_70pt_cfg("Q4 Oncology Brand Tracker"),
    })
    assert save_by_bob.status_code == 200, save_by_bob.get_json()

    # Bob also creates a 2nd project directly inside the shared team (team_id=team_id, 10 pts)
    cfg_10pt = {
        "title": "Team Pulse Survey",
        "sections": [{"id": "S1", "title": "Main", "blurb": None}],
        "questions": [{"id": "Q1", "section": "S1", "type": "single_select", "required": True,
                       "stem": "Overall satisfaction?", "options": [{"code": "1", "label": "High"}]}],
    }
    save_team_proj2 = client.post("/api/studio/save", headers=_h(client), json={
        "slug": "team-pulse-survey",
        "title": "Team Pulse Survey",
        "team_id": team_id,
        "cfg": cfg_10pt,
    })
    assert save_team_proj2.status_code == 200, save_team_proj2.get_json()

    # Verify Bob's Kart balance is STILL 100 / 100 (0 points used by Bob!)
    bob_kart = client.get("/api/kart/me").get_json()["kart"]
    assert bob_kart["points_used"] == 0
    assert bob_kart["points_balance"] == 100

    # 6. Switch back to Alice (Team Creator) ->
    #    - Alice sees Bob with his Account Name ("Bob Teammate") in the Team and on the Project!
    #    - Alice's Kart balance reflects 70 + 10 = 80 points used (20 balance remaining)!
    #    - Both shared projects have preview (/survey/<slug>) and test (/survey/<slug>/test) links!
    client.post("/auth/logout", headers=_h(client))
    client.post("/api/auth/login", headers=_h(client), json={
        "identifier": "alice.lead@gmail.com", "password": "password123"
    })
    alice_ws = client.get("/api/workspace/projects").get_json()
    assert alice_ws["kart"]["points_used"] == 80
    assert alice_ws["kart"]["points_balance"] == 20

    alice_team = alice_ws["teams"][0]
    assert alice_team["team_formed"] is True
    alice_seen_names = {m["account_name"]: m["status"] for m in alice_team["members"]}
    assert alice_seen_names.get("Bob Teammate") == "accepted"

    proj_map = {p["slug"]: p for p in alice_ws["projects"]}
    assert study_slug in proj_map
    assert "team-pulse-survey" in proj_map
    assert proj_map[study_slug]["survey_url"] == f"/survey/{study_slug}"
    assert proj_map[study_slug]["test_url"] == f"/survey/{study_slug}/test"
    collab_names_on_proj = [c["account_name"] for c in proj_map[study_slug]["collaborators"]]
    assert "Bob Teammate" in collab_names_on_proj

    # 7. Verify the short backend change log (SQLite + raw backend file /api/workspace/changelog.log)
    #    shows who made what changes to the project or link in very short!
    cl_resp = client.get(f"/api/workspace/changelog?study={study_slug}").get_json()
    assert cl_resp["ok"] is True
    summaries = [c["short_summary"] for c in cl_resp["changelogs"]]
    actors = [c["actor_name"] for c in cl_resp["changelogs"]]
    assert "Bob Teammate" in actors
    assert "Alice Researcher" in actors
    assert any("Added Q1 (single_select), Q2 (single_select), Q3 (sum_to_100)" in s for s in summaries), summaries

    raw_log = client.get(f"/api/workspace/changelog.log?study={study_slug}")
    assert raw_log.status_code == 200
    raw_text = raw_log.data.decode()
    assert "Bob Teammate" in raw_text
    assert "Added Q1 (single_select), Q2 (single_select), Q3 (sum_to_100)" in raw_text








def test_verbatim_xray_card_is_a_grid_card_like_every_other_demo(app, client):
    """The AI X-Ray demo is one of the demo-grid signature cards, not a separate banner.

    It used to sit in its own dark full-width banner section, which broke the rhythm of
    "Watch SurveyKart in action". It now renders inside .ln-demo-grid with the shared
    signature-card shape (.ln-demo.ln-demo-ai) and still owns the #ai-detect-demo anchor.
    """
    app.config["STAFF_AUTH"] = True
    html = client.get("/").data.decode("utf-8")

    # the card lives inside the demo grid, next to the other signature cards
    grid_start = html.index('<div class="ln-demo-grid">')
    grid_end = html.index('id="join"')
    xray = html.index('class="ln-demo ln-demo-ai')
    assert grid_start < xray < grid_end
    for sibling in ("ln-demo-sl", "ln-demo-voice", "ln-demo-walk"):
        assert sibling in html[grid_start:grid_end]

    # the standalone banner shells are gone, the anchor and the live engine are not
    for gone in ("sk-ai-banner-sec", "sk-ai-banner-shell", "sk-ai-mode-bar", "sk-ai-preset"):
        assert gone not in html, gone
    for kept in ('id="ai-detect-demo"', 'class="ai-presets"', 'data-ai-preset="chatgpt"',
                 'id="sk-ai-arc-fill"', 'id="sk-ai-viewport"', 'id="sk-ai-autocycle"'):
        assert kept in html, kept

    # one <h1> on the page and the card's own heading is an h3 in the demo rhythm
    assert html.count("<h1") == 1
    assert '<h3 id="ai-demo-heading">' in html


def test_landing_fills_the_side_gutters_with_a_live_canvas(app, client):
    """A neutral reading canvas retains quiet decorative detail in the side gutters."""
    app.config["STAFF_AUTH"] = True
    html = client.get("/").data.decode("utf-8")
    for needle in ("sk-ambient-canvas", "sk-amb-orb", "sk-amb-dial", "sk-ambient-rail",
                   "sk-amb-chip", "sk-amb-spine"):
        assert needle in html, needle
    css = client.get("/static/css/landing.css").data.decode("utf-8")
    for rule in (".sk-ambient-canvas::before", ".sk-ambient-canvas::after", "skAmbAurora",
                 ".sk-ambient-rail", "@media(max-width:1739px)"):
        assert rule in css, rule

    # Keep the central reading column clear: only the outer 19% of each side gets
    # texture, and the former saturated full-page colour washes must stay removed.
    assert "background-color:#f8f9f6" in css
    assert "transparent 19%, transparent 81%" in css
    for heavy_wash in ("rgba(245,158,11,0.20)", "rgba(20,97,79,0.16)",
                       "rgba(234,88,12,0.12)", "rgba(212,175,55,0.17)"):
        assert heavy_wash not in css, heavy_wash
