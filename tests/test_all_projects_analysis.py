"""
Test that the Enhanced Analysis Dashboard with live dynamic visuals,
statistical significance, and multiple interactive chart types works
for EVERY project (draft, live, with responses, without responses, across diverse question types).
"""

import io
import pptx
import pytest
from core.datacut import analyze_with_datacut


def test_analysis_across_multiple_diverse_projects(client):
    # Project 1: Consumer Brand Study with Gauge, Sum to 100, Emoji Grid, NPS
    proj1_cfg = {
        "title": "Consumer Brand Study",
        "sections": [{"id": "S1", "title": "Main"}],
        "questions": [
            {
                "id": "Q_NPS",
                "section": "S1",
                "type": "nps",
                "stem": "How likely are you to recommend our brand?",
            },
            {
                "id": "Q_GAUGE",
                "section": "S1",
                "type": "gauge_meter",
                "stem": "Brand momentum meter",
                "min": 0, "max": 100, "unit": "%", "target": 70,
            },
            {
                "id": "Q_SUM",
                "section": "S1",
                "type": "sum_to_100",
                "stem": "Allocate 100 points across competitors",
                "rows": [
                    {"code": "brand_a", "label": "Brand Alpha"},
                    {"code": "brand_b", "label": "Brand Beta"},
                ],
            },
            {
                "id": "Q_EMOJI",
                "section": "S1",
                "type": "emoji_grid",
                "stem": "Emotional reaction to our product",
                "rows": [
                    {"code": "feel", "label": "Excitement"},
                    {"code": "trust", "label": "Trustworthiness"},
                ],
            },
        ],
    }

    # Project 2: B2B Enterprise Study with Rank, Open Text, Multi-Select
    proj2_cfg = {
        "title": "B2B Tech Vendor Study",
        "sections": [{"id": "S1", "title": "Main"}],
        "questions": [
            {
                "id": "Q_SPEC",
                "section": "S1",
                "type": "single_select",
                "stem": "Company Size",
                "options": [{"code": 1, "label": "Small"}, {"code": 2, "label": "Enterprise"}],
            },
            {
                "id": "Q_RANK",
                "section": "S1",
                "type": "rank",
                "stem": "Rank vendor selection priorities",
                "options": [
                    {"code": "cost", "label": "Cost efficiency"},
                    {"code": "sec", "label": "Security"},
                    {"code": "supp", "label": "Customer support"},
                ],
            },
            {
                "id": "Q_TEXT",
                "section": "S1",
                "type": "open_text",
                "stem": "What is the primary factor driving your choice?",
            },
        ],
    }

    # Project 3: Fresh Empty Project (no responses yet)
    proj3_cfg = {
        "title": "Blank Draft Study",
        "sections": [{"id": "S1", "title": "Main"}],
        "questions": [
            {
                "id": "Q_EMPTY",
                "section": "S1",
                "type": "single_select",
                "stem": "Placeholder question",
                "options": [{"code": 1, "label": "Yes"}, {"code": 2, "label": "No"}],
            }
        ],
    }

    # Save all 3 projects
    r1 = client.post("/api/studio/save", json={"slug": "proj-consumer", "title": "Consumer Brand Study", "cfg": proj1_cfg}).get_json()
    r2 = client.post("/api/studio/save", json={"slug": "proj-b2b", "title": "B2B Tech Vendor Study", "cfg": proj2_cfg}).get_json()
    r3 = client.post("/api/studio/save", json={"slug": "proj-blank", "title": "Blank Draft Study", "cfg": proj3_cfg}).get_json()
    assert r1.get("ok") and r2.get("ok") and r3.get("ok")

    # Add responses to Proj 1 (Consumer)
    d1 = client.get("/api/workspace/study", query_string={"study": "proj-consumer"}).get_json()
    client.post("/api/workspace/review", json={"slug": "proj-consumer", "state": "approved", "digest": d1["digest"]})
    client.post("/api/workspace/publish", json={"slug": "proj-consumer"})

    for i in range(5):
        s = client.post("/api/start", json={"study": "proj-consumer"}).get_json()
        client.post("/api/submit", json={
            "session_id": s["session_id"],
            "answers": {
                "Q_NPS": {"_": 9 if i < 3 else 6},
                "Q_GAUGE": {"_": 82 if i < 3 else 60},
                "Q_SUM": {"brand_a": 60, "brand_b": 40},
                "Q_EMOJI": {"feel": 5, "trust": 4},
            },
            "elapsed_seconds": 200,
        })

    # Add responses to Proj 2 (B2B)
    d2 = client.get("/api/workspace/study", query_string={"study": "proj-b2b"}).get_json()
    client.post("/api/workspace/review", json={"slug": "proj-b2b", "state": "approved", "digest": d2["digest"]})
    client.post("/api/workspace/publish", json={"slug": "proj-b2b"})

    for i in range(6):
        s = client.post("/api/start", json={"study": "proj-b2b"}).get_json()
        client.post("/api/submit", json={
            "session_id": s["session_id"],
            "answers": {
                "Q_SPEC": {"_": 1 if i < 3 else 2},
                "Q_RANK": {"order": ["cost", "sec", "supp"] if i < 4 else ["sec", "cost", "supp"]},
                "Q_TEXT": {"_": "Great security and reliability for critical workloads"},
            },
            "elapsed_seconds": 240,
        })

    # 1. Verify Project 1 (Consumer) in Workspace & Studio analysis
    w1 = client.get("/api/workspace/analysis?study=proj-consumer&scope=all").get_json()
    assert w1["complete"] == 5
    nps_q = next(q for q in w1["questions"] if q["id"] == "Q_NPS")
    assert nps_q["nps"]["promoters_count"] == 3
    assert nps_q["nps"]["detractors_count"] == 2
    assert "promoter" in nps_q["insight"].lower()

    gauge_q = next(q for q in w1["questions"] if q["id"] == "Q_GAUGE")
    assert gauge_q["mean"] is not None
    assert len(gauge_q["zones"]) == 3

    sum_q = next(q for q in w1["questions"] if q["id"] == "Q_SUM")
    assert len(sum_q["rows"]) == 2
    assert sum_q["rows"][0]["mean"] == 60.0

    st1 = client.get("/api/studio/analysis?study=proj-consumer&scope=all").get_json()
    assert st1["complete"] == 5
    assert len(st1["questions"]) == 4

    # 2. Verify Project 2 (B2B) with Rank and Open Text
    w2 = client.get("/api/workspace/analysis?study=proj-b2b&scope=all").get_json()
    assert w2["complete"] == 6
    rank_q = next(q for q in w2["questions"] if q["id"] == "Q_RANK")
    cost_opt = next(o for o in rank_q["options"] if o["code"] == "cost")
    assert cost_opt["first_count"] == 4
    assert cost_opt["first_pct"] == 66.7

    text_q = next(q for q in w2["questions"] if q["id"] == "Q_TEXT")
    assert text_q["base"] == 6
    assert len(text_q["word_cloud"]) > 0
    assert any(w["word"] == "security" for w in text_q["word_cloud"])

    # 3. Verify Project 3 (Blank/Draft with 0 responses) doesn't crash
    w3 = client.get("/api/workspace/analysis?study=proj-blank").get_json()
    assert w3["complete"] == 0
    assert len(w3["questions"]) == 1
    assert "no completed responses" in w3["questions"][0]["insight"].lower()

    st3 = client.get("/api/studio/analysis?study=proj-blank").get_json()
    assert st3["complete"] == 0
    assert len(st3["questions"]) == 1

    # 4. Verify PPT export works for both projects
    ppt1 = client.get("/api/workspace/export_ppt?study=proj-consumer&scope=all")
    assert ppt1.status_code == 200
    prs1 = pptx.Presentation(io.BytesIO(ppt1.data))
    assert len(prs1.slides) >= 5

    ppt2 = client.get("/api/workspace/export_ppt?study=proj-b2b&scope=all")
    assert ppt2.status_code == 200
    prs2 = pptx.Presentation(io.BytesIO(ppt2.data))
    assert len(prs2.slides) >= 4
