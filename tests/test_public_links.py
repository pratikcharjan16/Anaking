"""Regression tests for resumable single-use public respondent links."""

import re

from models import get_db


def _live_study(client, slug="resume-link"):
    cfg = {
        "sections": [{"id": "S1", "title": "Intro"}],
        "questions": [
            {"id": "Q1", "section": "S1", "type": "open_text", "stem": "First answer"},
            {"id": "Q2", "section": "S1", "type": "open_text", "stem": "Second answer"},
        ],
    }
    saved = client.post("/api/studio/save", json={"slug": slug, "title": "Resume link", "cfg": cfg})
    assert saved.status_code == 200, saved.get_json()
    launched = client.post("/api/studio/launch", json={"slug": slug, "recipients": ""})
    assert launched.status_code == 200, launched.get_json()
    return slug


def test_token_link_resumes_saved_step_and_closes_after_completion(client, app):
    slug = _live_study(client)
    issued = client.post("/api/studio/public-link", json={"slug": slug})
    assert issued.status_code == 200, issued.get_json()
    token = issued.get_json()["token"]
    assert f"/survey/{slug}?rid={token}" in issued.get_json()["url"]
    assert client.get(f"/survey/{slug}?rid={token}").status_code == 200

    start = client.post("/api/start", json={"study": slug, "embedded": {"rid": token}})
    assert start.status_code == 200, start.get_json()
    first = start.get_json()
    sid = first["session_id"]
    saved = client.post("/api/save", json={
        "session_id": sid,
        "answers": {"Q1": {"_": "remember this"}},
        "current_step": 1,
        "elapsed_seconds": 36,
    })
    assert saved.status_code == 200, saved.get_json()

    # Reopening the same link on a fresh browser finds the same server-side response.
    resumed = client.post("/api/start", json={"study": slug, "embedded": {"rid": token}})
    assert resumed.status_code == 200, resumed.get_json()
    assert resumed.get_json()["resumed"] is True
    assert resumed.get_json()["session_id"] == sid
    progress = client.get("/api/progress", query_string={"sid": sid}).get_json()
    assert progress["answers"] == {"Q1": {"_": "remember this"}}
    assert progress["current_step"] == 1

    done = client.post("/api/submit", json={
        "session_id": sid,
        "answers": {"Q1": {"_": "remember this"}, "Q2": {"_": "finished"}},
        "current_step": 2,
        "elapsed_seconds": 65,
    })
    assert done.status_code == 200
    again = client.post("/api/start", json={"study": slug, "embedded": {"rid": token}})
    assert again.status_code == 200 and again.get_json()["completed"] is True
    page = client.get(f"/survey/{slug}?rid={token}")
    assert page.status_code == 200 and b"Already completed" in page.data
    assert client.post("/api/save", json={"session_id": sid, "answers": {"Q2": {"_": "overwrite"}}}).status_code == 409
    assert client.post("/api/submit", json={"session_id": sid}).status_code == 409

    with app.app_context():
        row = get_db().execute("SELECT status, current_step FROM respondents WHERE session_id=?", (sid,)).fetchone()
        assert row["status"] == "complete" and row["current_step"] == 2


def test_canonical_public_link_becomes_cookie_bound_token_and_resumes(client):
    slug = _live_study(client, "generic-resume")
    first = client.get(f"/survey/{slug}")
    assert first.status_code == 200
    token = re.search(rb'window\.STUDY\.rid="([^"]+)"', first.data).group(1).decode()
    assert first.headers.get("Set-Cookie")
    start = client.post("/api/start", json={"study": slug, "embedded": {"rid": token}}).get_json()
    client.post("/api/save", json={"session_id": start["session_id"], "current_step": 1,
                                  "answers": {"Q1": {"_": "saved"}}})
    # The test client retains the cookie: the ordinary public page keeps the same link token.
    next_open = client.get(f"/survey/{slug}")
    assert next_open.status_code == 200
    assert re.search(rb'window\.STUDY\.rid="([^"]+)"', next_open.data).group(1).decode() == token
    resume = client.post("/api/start", json={"study": slug, "embedded": {"rid": token}}).get_json()
    assert resume["resumed"] is True and resume["session_id"] == start["session_id"]


def test_invalid_token_link_is_not_accepted(client):
    slug = _live_study(client, "invalid-resume")
    page = client.get(f"/survey/{slug}?rid=not-a-token")
    assert page.status_code == 404 and b"not valid" in page.data
    response = client.post("/api/start", json={"study": slug, "embedded": {"rid": "not-a-token"}})
    assert response.status_code == 404
