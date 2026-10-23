"""The test survey link is a rehearsal: current design, blank answers, every open.

These guard the two failure modes reported from the Studio:
  * after editing a design the test link kept showing the old questionnaire, because the
    previous test session pinned a design snapshot and the browser resumed it; and
  * the test link arrived with the previous run's answers already filled in.
"""

import copy

CFG = {
    "language": "en-US",
    "sections": [{"id": "S1", "title": "Intro"}],
    "questions": [
        {"id": "Q1", "section": "S1", "type": "single_select", "stem": "Pick one",
         "options": [{"code": 1, "label": "A"}, {"code": 2, "label": "B"}]},
        {"id": "Q2", "section": "S1", "type": "open_text", "stem": "Why?"},
    ],
}


def make(client, slug="test-link", cfg=None):
    r = client.post("/api/studio/save", json={"slug": slug, "title": slug,
                                             "cfg": copy.deepcopy(cfg or CFG)})
    assert r.status_code == 200, r.get_json()
    return slug


def go_live(client, slug):
    r = client.post("/api/studio/status", json={"slug": slug, "status": "live"})
    assert r.status_code == 200, r.get_json()
    return slug


def start(client, slug, **extra):
    r = client.post("/api/start", json=dict(study=slug, **extra))
    assert r.status_code == 200, r.get_json()
    return r.get_json()


def test_test_session_always_sees_the_current_design(client):
    slug = make(client)
    test_run = start(client, slug, is_test=True)
    real_run = start(client, go_live(client, slug))

    changed = copy.deepcopy(CFG)
    changed["questions"][0]["stem"] = "Pick one - edited in the Studio"
    make(client, slug, changed)

    # the test session follows the saved design, with or without ?preview=1
    for query in ({"preview": "1", "sid": test_run["session_id"]},
                  {"sid": test_run["session_id"]}):
        spec = client.get("/api/spec/" + slug, query_string=query).get_json()
        assert spec["questions"][0]["stem"] == "Pick one - edited in the Studio"
        assert spec["test_mode"] is True
    # a real respondent keeps the version their session started with
    pinned = client.get("/api/spec/" + slug,
                        query_string={"sid": real_run["session_id"]}).get_json()
    assert pinned["questions"][0]["stem"] == "Pick one"


def test_test_page_reports_the_current_design_version(client):
    slug = make(client)
    before = client.get("/survey/" + slug + "/test")
    assert b"teambar-ver" in before.data and b"design " in before.data
    # the respondent page carries no team strip at all
    client.post("/api/studio/status", json={"slug": slug, "status": "live"})
    assert b"teambar-ver" not in client.get("/survey/" + slug).data

    changed = copy.deepcopy(CFG)
    changed["questions"][0]["stem"] = "Different wording"
    make(client, slug, changed)
    after = client.get("/survey/" + slug + "/test")
    assert before.data != after.data


def test_new_test_run_discards_the_previous_test_session(client):
    slug = make(client)
    old = start(client, slug, is_test=True)
    assert client.post("/api/save", json={
        "session_id": old["session_id"],
        "answers": {"Q1": {"_": 1}, "Q2": {"_": "because"}},
        "elapsed_seconds": 12,
    }).status_code == 200
    assert client.get("/api/progress", query_string={"sid": old["session_id"]}) \
        .get_json()["answers"]

    new = start(client, slug, is_test=True, previous_session=old["session_id"])
    assert new["session_id"] != old["session_id"]
    # the old run is gone, so a stale link cannot resume it or show its answers
    assert client.get("/api/progress",
                      query_string={"sid": old["session_id"]}).get_json() == {"exists": False}
    fresh = client.get("/api/progress", query_string={"sid": new["session_id"]}).get_json()
    assert fresh["answers"] == {}


def test_previous_session_never_discards_a_real_response(client):
    slug = go_live(client, make(client))
    real = start(client, slug)
    start(client, slug, is_test=True, previous_session=real["session_id"])
    progress = client.get("/api/progress", query_string={"sid": real["session_id"]}).get_json()
    assert progress["exists"] is True and progress["is_test"] is False


def test_discarding_is_scoped_to_the_same_study(client):
    a = make(client, "link-a")
    b = make(client, "link-b")
    other = start(client, a, is_test=True)
    start(client, b, is_test=True, previous_session=other["session_id"])
    # a test session of another study is not ours to delete
    assert client.get("/api/progress",
                      query_string={"sid": other["session_id"]}).get_json()["exists"] is True
