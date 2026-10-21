"""Research-agent questionnaire design, Word round trips, and saved chat memory."""

import io
import json
import zipfile
from xml.etree import ElementTree

from core.questionnaire_docx import build_questionnaire_docx
from core.research_agent import (SUPPORTED_TYPES, build_from_brief, build_from_document,
                                 parse_questionnaire, validate_model_questionnaire)


def _docx_text(data: bytes) -> str:
    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        root = ElementTree.fromstring(archive.read("word/document.xml"))
    lines = []
    for paragraph in root.iter():
        if paragraph.tag.endswith("}p"):
            text = "".join(node.text or "" for node in paragraph.iter() if node.tag.endswith("}t"))
            if text:
                lines.append(text)
    return "\n".join(lines)


def test_brief_design_is_studio_native_and_uses_only_explicit_screening():
    cfg = build_from_brief(
        "Mobile banking research",
        "Understand why sales declined, assess unmet needs and satisfaction for our mobile banking app.",
        "Current customers",
        "India",
    )
    assert [s["title"] for s in cfg["sections"]] == ["Screeners and eligibility", "Main questionnaire"]
    assert len(cfg["questions"]) >= 5
    assert all(q["type"] in SUPPORTED_TYPES for q in cfg["questions"])
    q1 = cfg["questions"][0]
    assert q1["screening"]["mode"] == "qualify"
    assert q1["screening"]["rules"] == [{"q": "Q1", "op": "selected", "value": "current"}]
    # A reason/barrier follow-up is shown only to respondents reporting a decline.
    conditional = [q for q in cfg["questions"] if q.get("show_if")]
    assert conditional
    assert all(rule["q"] == "Q2" for q in conditional for rule in q["show_if"]["rules"])
    assert all("decreased" in str(rule.get("value")) for q in conditional for rule in q["show_if"]["rules"])


def test_brief_without_audience_does_not_invent_screenouts():
    cfg = build_from_brief("Category study", "Understand how buyers choose a service category.")
    assert not any(q.get("screening") for q in cfg["questions"])
    assert any("does not exclude anyone" in n for n in cfg["design_notes"])


def test_editable_word_export_round_trips_types_options_logic_and_screening():
    cfg = build_from_brief("Mobile app study", "Understand why sales declined and assess unmet needs.",
                           "Current customers", "India")
    data = build_questionnaire_docx(cfg)
    assert data[:2] == b"PK"
    text = _docx_text(data)
    parsed = parse_questionnaire(text)
    assert parsed["found"] == len(cfg["questions"])
    rebuilt, info = build_from_document("Mobile app study", text, source_filename="questionnaire.docx")
    assert info["source_kind"] == "questionnaire"
    assert len(rebuilt["questions"]) == len(cfg["questions"])
    assert [q["id"] for q in rebuilt["questions"]] == [q["id"] for q in cfg["questions"]]
    assert rebuilt["questions"][0]["screening"]["mode"] == "qualify"
    assert rebuilt["questions"][-1]["show_if"]["rules"][0]["q"] == "Q2"
    assert rebuilt["questions"][2]["type"] == "rating_scale"
    assert rebuilt["questions"][3]["type"] == "multi_select"
    assert any(o.get("exclusive") for o in rebuilt["questions"][3]["options"])


def test_visible_word_routing_edits_override_round_trip_metadata():
    cfg = build_from_brief("Sales study", "Why sales declined and unmet needs", "Current customers")
    text = _docx_text(build_questionnaire_docx(cfg))
    visible = "FLOW / SCREENING: Show only if Q2 one or more of Decreased / Stopped using or purchasing"
    assert visible in text
    text = text.replace(visible, "FLOW / SCREENING: Show only if Q2 was answered as Stayed about the same", 1)
    rebuilt, _ = build_from_document("Sales study", text)
    q4 = next(q for q in rebuilt["questions"] if q["id"] == "Q4")
    assert q4["show_if"]["rules"] == [{"q": "Q2", "op": "selected", "value": "same"}]


def test_unformatted_questionnaire_keeps_every_numbered_question_and_infers_types():
    text = """Brand experience questionnaire
Section A: Screener
Q1. Are you a current customer?
1. Yes
2. No (screen out)
Section B: Main
Q2. How satisfied are you with the service?
1. Very dissatisfied
2. Dissatisfied
3. Neither satisfied nor dissatisfied
4. Satisfied
5. Very satisfied
Q3. What is one thing you would improve?
"""
    cfg, info = build_from_document("Imported study", text, source_filename="source.txt")
    assert info["found"] == info["imported"] == 3
    assert [q["stem"] for q in cfg["questions"]] == [
        "Are you a current customer?", "How satisfied are you with the service?",
        "What is one thing you would improve?",
    ]
    assert cfg["questions"][0]["section"] == "A"
    assert cfg["questions"][1]["section"] == "B"
    assert cfg["questions"][0]["screening"]["mode"] == "screen_out"
    assert cfg["questions"][1]["type"] == "rating_scale"
    assert cfg["questions"][1]["scale"]["min"] == 1 and cfg["questions"][1]["scale"]["max"] == 5
    assert cfg["questions"][2]["type"] == "open_text"


def test_imported_routing_instructions_become_show_if_rules():
    text = """Screeners
Q1. Have you used the service?
1. Yes
2. No
Main
Q2. What did you like about the service?
Routing: Ask only if Q1 = Yes
"""
    cfg, info = build_from_document("Imported", text)
    assert info["imported"] == 2
    assert cfg["questions"][1]["show_if"] == {
        "match": "all", "rules": [{"q": "Q1", "op": "selected", "value": 1}]
    }


def test_question_id_show_if_instruction_and_numeric_route_are_inferred():
    text = """SECTION: A | Screeners
QUESTION ID: Q1 | TYPE: single_select | REQUIRED: yes
QUESTION TEXT: Are you eligible?
OPTION: 1 | Yes
OPTION: 2 | No
SECTION: B | Main
QUESTION ID: Q2 | TYPE: open_text | REQUIRED: no
QUESTION TEXT: Please explain.
Q2 is shown only if Q1 = 1
QUESTION ID: Q3 | TYPE: numeric | REQUIRED: yes
QUESTION TEXT: Enter your monthly visits.
RANGE: 0 | 100 | 1
QUESTION ID: Q4 | TYPE: open_text | REQUIRED: no
QUESTION TEXT: What changed?
If Q3 is greater than 10, ask Q4
"""
    cfg, info = build_from_document("Imported", text)
    assert info["imported"] == 4
    assert cfg["questions"][1]["show_if"]["rules"] == [{"q": "Q1", "op": "selected", "value": 1}]
    assert cfg["questions"][3]["show_if"]["rules"] == [{"q": "Q3", "op": "gt", "value": 10}]


def test_corrupt_hidden_logic_metadata_is_dropped_safely():
    text = """SECTION: B | Main
QUESTION ID: Q1 | TYPE: single_select | REQUIRED: yes
QUESTION TEXT: Select one answer.
OPTION: 1 | Yes
OPTION: 2 | No
STUDIO_FLOW_JSON: {"show_if":{"rules":[null]},"screening":{"rules":[null]}}
END QUESTION
"""
    cfg, info = build_from_document("Imported", text)
    assert info["imported"] == 1
    assert "show_if" not in cfg["questions"][0]
    assert "screening" not in cfg["questions"][0]


def test_model_questionnaire_validation_drops_non_studio_types_and_later_logic():
    candidate = {
        "sections": [{"id": "A", "title": "Screeners"}, {"id": "B", "title": "Main"}],
        "questions": [
            {"id": "Q1", "section": "A", "type": "single_select", "stem": "Eligible?",
             "options": [{"code": 1, "label": "Yes"}, {"code": 2, "label": "No"}]},
            {"id": "Q2", "section": "B", "type": "made_up_type", "stem": "Tell us more.",
             "show_if": {"match": "all", "rules": [{"q": "Q3", "op": "answered"}]}},
        ],
    }
    cfg, warnings = validate_model_questionnaire(candidate, "Study", "Brief")
    assert all(q["type"] in SUPPORTED_TYPES for q in cfg["questions"])
    assert cfg["questions"][1]["type"] == "open_text"
    assert "show_if" not in cfg["questions"][1]
    assert warnings


def test_configured_local_model_requires_consent_and_is_validated(app, client, monkeypatch):
    import routes.studio as studio_routes

    candidate = {
        "sections": [{"id": "A", "title": "Screeners"}, {"id": "B", "title": "Main"}],
        "questions": [
            {"id": "Q1", "section": "A", "type": "single_select", "stem": "Are you a current customer?",
             "options": [{"code": "yes", "label": "Yes"}, {"code": "no", "label": "No"}],
             "screening": {"mode": "qualify", "rules": [{"q": "Q1", "op": "selected", "value": "yes"}]}},
            {"id": "Q2", "section": "B", "type": "single_select", "stem": "How often do you use it?",
             "options": [{"code": 1, "label": "Daily"}, {"code": 2, "label": "Weekly"}]},
            {"id": "Q3", "section": "B", "type": "open_text", "stem": "What would you improve?"},
        ],
        "assistant_message": "I drafted a first version for review.",
    }
    app.config.update(LOCAL_AI_URL="http://configured-model", LOCAL_AI_MODEL="research-test")
    calls = []

    class FakeResponse:
        def __enter__(self):
            return self
        def __exit__(self, *_args):
            return False
        def read(self, _limit):
            return json.dumps({"response": json.dumps(candidate)}).encode()

    def fake_urlopen(request, timeout):
        calls.append((request.full_url, timeout, json.loads(request.data)))
        return FakeResponse()

    monkeypatch.setattr(studio_routes.urllib.request, "urlopen", fake_urlopen)
    no_consent = client.post("/api/studio/agent/start", json={
        "title": "Model study", "brief": "Understand customer use.", "model_consent": False,
    })
    assert no_consent.status_code == 200 and calls == []
    consented = client.post("/api/studio/agent/start", json={
        "title": "Model study", "brief": "Understand customer use.", "audience": "Current customers",
        "model_consent": True,
    })
    assert consented.status_code == 200, consented.get_json()
    assert len(calls) == 1 and calls[0][0].endswith("/api/generate")
    assert calls[0][2]["model"] == "research-test"
    assert "assistant_message" not in consented.get_json()["cfg"]
    assert all(q["type"] in SUPPORTED_TYPES for q in consented.get_json()["cfg"]["questions"])
    assert consented.get_json()["messages"][-1]["content"] == candidate["assistant_message"]


def test_draft_survey_mode_creates_a_studio_project_directly_from_the_questionnaire(client):
    source = """Screeners
Q1. Are you a current customer?
1. Yes
2. No
Main questionnaire
Q2. How satisfied are you?
1. Very dissatisfied
2. Dissatisfied
3. Neither satisfied nor dissatisfied
4. Satisfied
5. Very satisfied
Q3. What would you improve?
"""
    response = client.post("/api/studio/agent/start", json={
        "title": "Direct survey draft", "source_text": source,
        "source_filename": "questionnaire.txt", "mode": "draft",
    })
    assert response.status_code == 200, response.get_json()
    draft = response.get_json()
    assert draft["cfg"]["creation_mode"] == "draft"
    assert [q["type"] for q in draft["cfg"]["questions"]] == ["single_select", "rating_scale", "open_text"]
    assert draft["summary"]["questions"] == 3
    assert client.get("/api/studio/study", query_string={"slug": draft["slug"]}).status_code == 200
    assert client.get("/survey/" + draft["slug"] + "/test").status_code == 200

    brief_only = client.post("/api/studio/agent/start", json={
        "title": "Not a questionnaire", "source_text": "We need to understand customer needs.", "mode": "draft",
    })
    assert brief_only.status_code == 400


def test_document_reader_feeds_the_questionnaire_conversion_flow(client):
    source = b"""Screeners
Q1. Are you a current customer?
1. Yes
2. No
Main
Q2. What should improve?
"""
    read = client.post("/api/studio/import-document", data={
        "file": (io.BytesIO(source), "customer_questionnaire.txt"),
    }, content_type="multipart/form-data")
    assert read.status_code == 200, read.get_json()
    extracted = read.get_json()
    assert extracted["filename"] == "customer_questionnaire.txt"
    assert "Q1. Are you a current customer?" in extracted["text"]
    start = client.post("/api/studio/agent/start", json={
        "title": "Uploaded questionnaire", "brief": "Keep the question wording.",
        "source_text": extracted["text"], "source_filename": extracted["filename"], "mode": "upload",
    })
    assert start.status_code == 200, start.get_json()
    assert start.get_json()["summary"]["questions"] == 2


def test_agent_start_chat_revision_and_word_download_are_saved(client):
    response = client.post("/api/studio/agent/start", json={
        "title": "Customer feedback",
        "brief": "Understand customer satisfaction with a delivery service and identify improvements.",
        "audience": "Current customers",
        "market": "India",
    })
    assert response.status_code == 200, response.get_json()
    started = response.get_json()
    slug = started["slug"]
    assert started["summary"]["questions"] >= 4
    assert len(started["messages"]) == 2
    assert client.get("/survey/" + slug + "/test").status_code == 200

    turn = client.post("/api/studio/agent/turn", json={"slug": slug, "message": "Shorten Q2 and add a question about trust."})
    assert turn.status_code == 200, turn.get_json()
    result = turn.get_json()
    assert len(result["messages"]) == 4
    assert any(q["stem"].startswith("How important is trust") for q in result["cfg"]["questions"])
    assert result["cfg"]["research_brief"] == started["cfg"]["research_brief"]

    saved = client.get("/api/studio/agent", query_string={"study": slug}).get_json()
    assert len(saved["messages"]) == 4
    assert saved["memory"]["audience"] == "Current customers"
    doc = client.get("/api/studio/questionnaire.docx", query_string={"study": slug})
    assert doc.status_code == 200 and doc.data[:2] == b"PK"


def test_restricted_staff_cannot_create_or_cross_scope_agent_studies(app, client):
    from core.security import create_user
    from models import Study

    cfg = {"sections": [{"id": "A", "title": "Main"}], "questions": []}
    app.config["STAFF_AUTH"] = True
    with app.app_context():
        Study.save({"slug": "research-scope", "title": "Research scope", "cfg": cfg})
        Study.save({"slug": "outside-scope", "title": "Outside scope", "cfg": cfg})
        create_user("researcher", "long-test-password", "editor", ["research-scope"])
    html = client.get("/login").data
    import re
    token = re.search(rb'name="csrf" value="([^"]+)"', html).group(1).decode()
    assert client.post("/login", data={"username": "researcher", "password": "long-test-password", "csrf": token}).status_code == 302
    with client.session_transaction() as saved:
        headers = {"X-CSRF-Token": saved["csrf"]}
    assert client.post("/api/studio/agent/start", headers=headers,
                       json={"title": "New", "brief": "Study customers"}).status_code == 403
    assert client.get("/api/studio/agent?study=research-scope").status_code == 200
    cross_scope = client.post("/api/studio/agent/turn", headers=headers,
                              data={"slug": "outside-scope", "message": "Remove Q1"},
                              content_type="multipart/form-data")
    assert cross_scope.status_code == 403


def test_agent_can_reimport_an_edited_word_document_through_chat(client):
    source = """Screeners
Q1. Are you a customer?
1. Yes
2. No
Main questionnaire
Q2. How often do you use the service?
1. Daily
2. Weekly
3. Monthly
Q3. What should be improved?
"""
    start = client.post("/api/studio/agent/start", json={
        "title": "Imported survey", "brief": "Use the uploaded questionnaire.",
        "source_text": source, "source_filename": "edited_source.txt", "mode": "upload",
    })
    assert start.status_code == 200, start.get_json()
    slug = start.get_json()["slug"]
    assert len(start.get_json()["cfg"]["questions"]) == 3

    doc_data = build_questionnaire_docx(start.get_json()["cfg"])
    response = client.post("/api/studio/agent/turn", data={
        "slug": slug, "message": "Use this edited questionnaire as the new version.",
        "file": (io.BytesIO(doc_data), "edited_questionnaire.docx"),
    }, content_type="multipart/form-data")
    assert response.status_code == 200, response.get_json()
    result = response.get_json()
    assert len(result["cfg"]["questions"]) == 3
    assert result["messages"][-2]["attachment"] == "edited_questionnaire.docx"
    assert "preserved" in result["messages"][-1]["content"]
    assert result["memory"]["source_filename"] == "edited_questionnaire.docx"
