"""
Gauge Meter questions end-to-end:
- Single gauge and multi-row gauge meters
- Flattening for data exports
- Data dictionary documentation with min-max and anchor labels
- Analysis summary calculation (mean, median, zones, base)
- Translation extraction and application
"""

import pytest
from core.i18n import apply_language, extract_strings
from core.reporting import analysis_for, build_sheets, flatten
from core.research import summarize


GAUGE_CFG = {
    "title": "Gauge meter study",
    "sections": [{"id": "S1", "title": "Gauges"}],
    "questions": [
        {
            "id": "GM1",
            "section": "S1",
            "type": "gauge_meter",
            "stem": "Rate your overall satisfaction",
            "min": 0,
            "max": 100,
            "unit": "%",
            "target": 75,
            "min_label": "Poor",
            "mid_label": "Moderate",
            "max_label": "Excellent",
        },
        {
            "id": "GM2",
            "section": "S1",
            "type": "gauge_meter",
            "stem": "Rate each aspect on the gauge",
            "min": 0,
            "max": 10,
            "unit": "pts",
            "rows": [
                {"code": "speed", "label": "Processing speed"},
                {"code": "ui", "label": "UI elegance"},
            ],
            "min_label": "Low",
            "mid_label": "Average",
            "max_label": "High",
        },
    ],
}

ANSWERS = {
    "GM1": {"_": 85},
    "GM2": {"speed": 9, "ui": 8},
}

RESPONDENT = {
    "respondent_code": "T001",
    "is_test": 1,
    "status": "complete",
    "screen_out_at": None,
    "screen_out_reason": None,
    "started_at": "2026-01-01 10:00:00",
    "completed_at": "2026-01-01 10:05:00",
    "elapsed_seconds": 300,
    "embedded": "{}",
    "language": "en-US",
}


def test_gauge_meter_flattens_single_and_row_values():
    flat = flatten(RESPONDENT, ANSWERS, GAUGE_CFG)
    assert flat["GM1"] == 85
    assert flat["GM2_speed"] == 9
    assert flat["GM2_ui"] == 8


def test_gauge_meter_in_data_dictionary():
    sheets = build_sheets([{**RESPONDENT, "answers": ANSWERS, "is_test_label": "test",
                            "flat": flatten(RESPONDENT, ANSWERS, GAUGE_CFG)}],
                          "all", GAUGE_CFG)
    dd = next(rows for name, headers, rows, _w in sheets if name == "Data dictionary")
    gm1_row = next(r for r in dd if r[0] == "GM1")
    assert gm1_row[2] == "gauge_meter"
    assert "0-100 %" in gm1_row[6]
    assert "Poor / Moderate / Excellent" in gm1_row[6]

    gm2_rows = [r for r in dd if r[0] == "GM2"]
    assert len(gm2_rows) == 2
    assert gm2_rows[0][4] == "speed"
    assert "0-10 pts" in gm2_rows[0][6]


def test_gauge_meter_feeds_analysis():
    records = [{**RESPONDENT, "answers": ANSWERS}]
    out = analysis_for(records, GAUGE_CFG)
    assert len(out.get("gauges", [])) == 2
    g1 = next(g for g in out["gauges"] if g["id"] == "GM1")
    assert g1["mean"] == 85.0
    assert g1["min"] == 0
    assert g1["max"] == 100

    g2 = next(g for g in out["gauges"] if g["id"] == "GM2")
    assert len(g2["rows"]) == 2
    assert {r["label"]: r["mean"] for r in g2["rows"]} == {
        "Processing speed": 9.0,
        "UI elegance": 8.0,
    }


def test_gauge_meter_summarize_and_zones():
    records = [
        {**RESPONDENT, "answers": {"GM1": {"_": 20}, "GM2": {"speed": 2, "ui": 3}}},
        {**RESPONDENT, "answers": {"GM1": {"_": 85}, "GM2": {"speed": 8, "ui": 9}}},
    ]
    summary = summarize(records, GAUGE_CFG)
    q1 = next(q for q in summary["questions"] if q["id"] == "GM1")
    assert q1["base"] == 2
    assert q1["mean"] == 52.5
    assert len(q1["zones"]) == 3
    # 20 is < 40% (low), 85 is > 70% (high)
    assert q1["zones"][0]["count"] == 1  # low
    assert q1["zones"][2]["count"] == 1  # high


def test_gauge_meter_anchor_labels_translation():
    keys = {s["key"]: s["text"] for s in extract_strings(GAUGE_CFG)}
    assert keys["q:GM1:min_label"] == "Poor"
    assert keys["q:GM1:mid_label"] == "Moderate"
    assert keys["q:GM1:max_label"] == "Excellent"
    assert keys["q:GM2:row:speed"] == "Processing speed"
