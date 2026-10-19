"""
Statistical significance testing, data cuts, dynamic insights, and editable PPT exports.
"""

import copy
import io
import pptx
from core.datacut import two_proportion_z_test, two_sample_t_test, analyze_with_datacut
from core.ppt_export import build_ppt_report

CFG = {
    "title": "Oncology Market Insights",
    "sections": [{"id": "S1", "title": "Main"}],
    "questions": [
        {
            "id": "Q1",
            "section": "S1",
            "type": "single_select",
            "stem": "What is your medical specialty?",
            "options": [
                {"code": 1, "label": "Oncology"},
                {"code": 2, "label": "Haematology"},
            ],
        },
        {
            "id": "Q2",
            "section": "S1",
            "type": "single_select",
            "stem": "Which primary therapy do you prescribe?",
            "options": [
                {"code": "chemo", "label": "Chemotherapy"},
                {"code": "io", "label": "Immunotherapy"},
            ],
        },
        {
            "id": "R1",
            "section": "S1",
            "type": "rating_scale",
            "stem": "Rate treatment satisfaction",
            "rows": [
                {"code": "eff", "label": "Efficacy"},
                {"code": "tol", "label": "Tolerability"},
            ],
            "scale": {"min": 1, "max": 5, "min_label": "Poor", "max_label": "Excellent"},
        },
        {
            "id": "G1",
            "section": "S1",
            "type": "gauge_meter",
            "stem": "Overall clinic adoption gauge",
            "min": 0,
            "max": 100,
            "unit": "%",
            "target": 70,
        },
    ],
}


def test_two_proportion_z_test():
    # 60 out of 100 vs 30 out of 100 -> large significant difference
    res = two_proportion_z_test(60, 100, 30, 100)
    assert res["significant"] is True
    assert res["sig_95"] is True
    assert res["sig_99"] is True
    assert res["higher"] == "A"
    assert res["p_value"] < 0.001
    assert res["z"] > 4.0

    # 50 out of 100 vs 48 out of 100 -> non-significant
    res2 = two_proportion_z_test(50, 100, 48, 100)
    assert res2["significant"] is False
    assert res2["p_value"] > 0.5


def test_two_sample_t_test():
    # Mean 4.8 vs Mean 2.5
    v1 = [4.5, 4.8, 5.0, 4.9, 4.7, 5.0, 4.8]
    v2 = [2.0, 2.5, 3.0, 2.2, 2.8, 2.1, 2.4]
    t_res = two_sample_t_test(v1, v2)
    assert t_res["significant"] is True
    assert t_res["higher"] == "A"
    assert t_res["p_value"] < 0.001


def test_analyze_with_datacut_and_insights():
    # Construct 40 Oncology respondents and 40 Haematology respondents
    records = []
    # Oncology: 35 prefer IO, 5 prefer Chemo; high satisfaction
    for i in range(40):
        records.append({
            "status": "complete",
            "answers": {
                "Q1": {"_": 1},
                "Q2": {"_": "io" if i < 35 else "chemo"},
                "R1": {"eff": 5 if i < 30 else 4, "tol": 4},
                "G1": {"_": 85 if i < 30 else 75},
            },
            "elapsed_seconds": 300,
        })
    # Haematology: 10 prefer IO, 30 prefer Chemo; moderate satisfaction
    for i in range(40):
        records.append({
            "status": "complete",
            "answers": {
                "Q1": {"_": 2},
                "Q2": {"_": "io" if i < 10 else "chemo"},
                "R1": {"eff": 3 if i < 30 else 2, "tol": 3},
                "G1": {"_": 55 if i < 30 else 60},
            },
            "elapsed_seconds": 320,
        })

    # Cut by Q1 (Specialty)
    out = analyze_with_datacut(records, CFG, cut_q_id="Q1", cut_v1="1", cut_v2="2", alpha=0.05)

    assert out["complete"] == 80
    assert out["data_cut"]["active"] is True
    assert out["data_cut"]["segA_label"] == "Oncology"
    assert out["data_cut"]["segB_label"] == "Haematology"

    q2 = next(q for q in out["questions"] if q["id"] == "Q2")
    io_opt = next(o for o in q2["options"] if o["code"] == "io")
    # Oncology: 35/40 (87.5%), Haematology: 10/40 (25.0%)
    assert io_opt["segA_pct"] == 87.5
    assert io_opt["segB_pct"] == 25.0
    assert io_opt["sig_test"]["significant"] is True
    assert io_opt["sig_test"]["higher"] == "A"
    assert "significant" in q2["insight"].lower()

    # R1: rating scale
    r1 = next(q for q in out["questions"] if q["id"] == "R1")
    eff_row = next(r for r in r1["rows"] if r["code"] == "eff")
    assert eff_row["segA_mean"] > eff_row["segB_mean"]
    assert eff_row["sig_test"]["significant"] is True
    assert "significant" in r1["insight"].lower()

    # G1: gauge meter
    g1 = next(q for q in out["questions"] if q["id"] == "G1")
    assert g1["segment_stats"]["segA"]["mean"] > g1["segment_stats"]["segB"]["mean"]
    assert g1["segment_stats"]["sig_test"]["significant"] is True


def test_ppt_export_full_single_and_custom():
    records = [
        {"status": "complete", "answers": {"Q1": {"_": 1}, "Q2": {"_": "io"}, "R1": {"eff": 4, "tol": 5}, "G1": {"_": 80}}, "elapsed_seconds": 250},
        {"status": "complete", "answers": {"Q1": {"_": 2}, "Q2": {"_": "chemo"}, "R1": {"eff": 3, "tol": 3}, "G1": {"_": 65}}, "elapsed_seconds": 280},
    ]
    summary = analyze_with_datacut(records, CFG, cut_q_id="Q1", cut_v1="1", cut_v2="2")

    # 1. Full presentation
    ppt_full = build_ppt_report("Full Deck Test", summary)
    prs_full = pptx.Presentation(io.BytesIO(ppt_full))
    # Title slide + KPI slide + 4 questions = 6 slides
    assert len(prs_full.slides) == 6

    # 2. Single question presentation
    ppt_single = build_ppt_report("Single Q Test", summary, questions_to_include=["G1"])
    prs_single = pptx.Presentation(io.BytesIO(ppt_single))
    assert len(prs_single.slides) == 1

    # 3. Custom question set (2 questions)
    ppt_custom = build_ppt_report("Custom Q Test", summary, questions_to_include=["Q2", "R1"])
    prs_custom = pptx.Presentation(io.BytesIO(ppt_custom))
    # Title slide + KPI slide + 2 questions = 4 slides
    assert len(prs_custom.slides) == 4


def test_workspace_export_ppt_endpoint(client):
    slug = "ppt-test-slug"
    client.post("/api/studio/save", json={"slug": slug, "title": "PPT Test", "cfg": CFG})
    d = client.get("/api/workspace/study", query_string={"study": slug}).get_json()
    client.post("/api/workspace/review", json={"slug": slug, "state": "approved", "digest": d["digest"]})
    pub = client.post("/api/workspace/publish", json={"slug": slug})
    assert pub.status_code == 200

    # Save a complete response
    r = client.post("/api/start", json={"study": slug}).get_json()
    sid = r["session_id"]
    client.post("/api/submit", json={
        "session_id": sid,
        "answers": {"Q1": {"_": 1}, "Q2": {"_": "io"}, "R1": {"eff": 4, "tol": 5}, "G1": {"_": 85}},
        "elapsed_seconds": 200
    })

    # Test full PPT download
    resp_full = client.get(f"/api/workspace/export_ppt?study={slug}&scope=real")
    assert resp_full.status_code == 200
    assert "presentation" in resp_full.headers["Content-Type"]
    assert len(resp_full.data) > 10000

    # Test single question PPT download
    resp_single = client.get(f"/api/workspace/export_ppt?study={slug}&scope=real&q=G1")
    assert resp_single.status_code == 200
    assert len(resp_single.data) > 5000

    # Test custom question set PPT download
    resp_custom = client.get(f"/api/workspace/export_ppt?study={slug}&scope=real&questions=Q1,R1")
    assert resp_custom.status_code == 200
    assert len(resp_custom.data) > 10000
