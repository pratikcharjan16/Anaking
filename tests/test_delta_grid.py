"""
The Delta question as a carried-forward grid: one number per row x new column,
with the source question's columns and rows reproduced for reference.

Covers the two ends of the feature - the export / data dictionary / research
summary on the new grid shape, and the original two-cell before / after / change
Delta that studies saved before it still use.

    python3 -m pytest tests/test_delta_grid.py
"""

import csv
import io

from core.reporting import build_sheets, flatten
from core.research import summarize

# A Delta that duplicated an earlier numeric matrix: its two columns came across as
# reference, one new column is where the answers go, and all three rows are still listed.
GRID_CFG = {
    "title": "Delta grid",
    "sections": [{"id": "S1", "title": "Main"}],
    "questions": [
        {"id": "G1", "section": "S1", "type": "numeric_matrix", "stem": "What was in place before?",
         "min": 0, "max": 100,
         "rows": [{"code": "r1", "label": "Region A"}, {"code": "r2", "label": "Region B"}],
         "cols": [{"code": "c1", "label": "Baseline"}, {"code": "c2", "label": "Target"}]},
        {"id": "D1", "section": "S1", "type": "delta", "stem": "What will you put in place now?",
         "delta_source": "G1", "min": 0, "max": 100, "step": 1, "delta_total": 200,
         "cols": [{"code": "dscc1", "label": "Baseline", "kind": "src", "src_code": "c1", "src_q": "G1"},
                  {"code": "dscc2", "label": "Target", "kind": "src", "src_code": "c2", "src_q": "G1"},
                  {"code": "n1", "label": "New plan", "kind": "delta"}],
         "rows": [{"code": "r1", "label": "Region A", "ref": {"dscc1": "10", "dscc2": "90"}},
                  {"code": "r2", "label": "Region B", "ref": {"dscc1": "25", "dscc2": "75"}}]},
    ],
    "qc": {"min_seconds": 1},
}

# The two-cell Delta a study saved before the grid: before, after, and the difference.
PAIR_CFG = {
    "title": "Delta pair",
    "sections": [{"id": "S1", "title": "Main"}],
    "questions": [
        {"id": "P1", "section": "S1", "type": "delta", "stem": "Before and after",
         "before_label": "Before", "after_label": "After", "min": 0, "max": 100},
    ],
    "qc": {"min_seconds": 1},
}


def _respondent(i, answers, cfg, status="complete"):
    return {"respondent_code": "R%d" % i, "status": status, "elapsed_seconds": 60,
            "duration_seconds": 60, "language": "en-US", "is_test": False,
            "answers": answers, "embedded": "{}", "extra": {},
            "screen_out_at": None, "screen_out_reason": None, "started_at": "",
            "completed_at": ""}


def _records(cfg, answers, status="complete"):
    recs = [_respondent(i, a, cfg, status) for i, a in enumerate(answers)]
    # build_sheets reads the flattened row, the way an export attaches it before rendering
    for r in recs:
        r["flat"] = flatten(r, r["answers"], cfg)
    return recs


def _data_dictionary(cfg):
    """The Data dictionary sheet, as an export would build it."""
    sheets = build_sheets(_records(cfg, [{}]), "all", cfg)
    name, headers, rows, _ = next(s for s in sheets if s[0] == "Data dictionary")
    return headers, rows


# ---------------------------------------------------------------- the export
def test_a_grid_delta_flattens_one_column_per_new_cell():
    q = GRID_CFG["questions"][1]
    rec = _respondent(1, {"D1": {"r1_n1": "60", "r2_n1": "140"}}, GRID_CFG)
    out = flatten(rec, rec["answers"], GRID_CFG)
    assert out["D1_r1_n1"] == "60" and out["D1_r2_n1"] == "140"
    # the carried columns are reference only, so they never carry an answer
    assert not any(k.startswith("D1_") and ("dscc" in k) for k in out)
    assert "D1_before" not in out and "D1_delta" not in out


def test_a_grid_delta_records_an_na_row():
    rec = _respondent(1, {"D1": {"r1_n1": "60", "r2": "NA"}}, GRID_CFG)
    out = flatten(rec, rec["answers"], GRID_CFG)
    assert out["D1_r2"] == "NA" and out["D1_r1_n1"] == "60"


def test_the_pair_delta_keeps_before_after_and_change():
    rec = _respondent(1, {"P1": {"before": "3", "after": "9", "delta": 6}}, PAIR_CFG)
    out = flatten(rec, rec["answers"], PAIR_CFG)
    assert out["P1_before"] == "3" and out["P1_after"] == "9" and out["P1_delta"] == 6
    # an unanswerable pair leaves the change blank rather than raising
    half = _respondent(2, {"P1": {"before": "3"}}, PAIR_CFG)
    assert flatten(half, half["answers"], PAIR_CFG)["P1_delta"] == ""


# ---------------------------------------------------------------- the data dictionary
def test_the_data_dictionary_lists_every_new_cell():
    headers, dd = _data_dictionary(GRID_CFG)
    rows = [r for r in dd if r[0] == "D1"]
    keys = [r[4] for r in rows]
    assert keys == ["r1_n1", "r2_n1"]
    assert all(r[2] == "delta" for r in rows)
    # each entry names the row and the new column it answers, and traces the source
    assert rows[0][5] == "Region A \u00D7 New plan (carried from G1)"
    assert "Region B \u00D7 New plan (carried from G1)" in [r[5] for r in rows]


def test_the_data_dictionary_keeps_the_pair_delta_as_one_entry():
    headers, dd = _data_dictionary(PAIR_CFG)
    rows = [r for r in dd if r[0] == "P1"]
    assert len(rows) == 1 and rows[0][4] == "before/after/delta"


# ---------------------------------------------------------------- the research summary
def test_research_gives_a_mean_per_row_and_per_new_column():
    recs = _records(GRID_CFG, [
        {"D1": {"r1_n1": "60", "r2_n1": "140"}},
        {"D1": {"r1_n1": "80", "r2_n1": "160"}},
    ])
    s = summarize(recs, GRID_CFG)
    q = next(x for x in s["questions"] if x["id"] == "D1")
    assert [r["label"] for r in q["rows"]] == ["Region A", "Region B"]
    assert [r["mean"] for r in q["rows"]] == [70.0, 150.0]
    assert [c["label"] for c in q["columns"]] == ["New plan"]
    assert q["columns"][0]["mean"] == 110.0
    assert q["columns"][0]["base"] == 4


def test_research_leaves_a_blank_column_alone():
    recs = _records(GRID_CFG, [{"D1": {"r1_n1": "60"}}])
    s = summarize(recs, GRID_CFG)
    q = next(x for x in s["questions"] if x["id"] == "D1")
    # Region B was never answered, so it has no mean rather than a zero one
    assert q["rows"][1]["mean"] is None and q["rows"][0]["mean"] == 60.0


def test_research_still_reads_the_pair_delta():
    recs = _records(PAIR_CFG, [{"P1": {"before": "3", "after": "9", "delta": 6}}])
    s = summarize(recs, PAIR_CFG)
    q = next(x for x in s["questions"] if x["id"] == "P1")
    assert q["type"] == "delta" and q["base"] >= 0


# ---------------------------------------------------------------- end to end through the survey
def _live(client, cfg, slug, answers):
    r = client.post("/api/studio/save", json={"slug": slug, "title": cfg["title"], "cfg": cfg})
    assert r.status_code == 200, r.get_json()
    client.post("/api/studio/status", json={"slug": slug, "status": "live"})
    s = client.post("/api/start", json={"study": slug, "is_test": False}).get_json()
    sid = s["session_id"]
    client.post("/api/save", json={"session_id": sid, "elapsed_seconds": 30, "answers": answers})
    client.post("/api/submit", json={"session_id": sid, "elapsed_seconds": 60})
    return sid


def test_a_grid_delta_flows_into_the_export(client):
    _live(client, GRID_CFG, "delta-grid", {"D1": {"r1_n1": "60", "r2_n1": "140"}})
    r = client.get("/admin/export.csv", query_string={"study": "delta-grid"})
    row = next(csv.DictReader(io.StringIO(r.data.decode())))
    assert row["D1_r1_n1"] == "60" and row["D1_r2_n1"] == "140"
    assert "D1_before" not in row and "D1_delta" not in row


def test_the_pair_delta_flows_into_the_export(client):
    _live(client, PAIR_CFG, "delta-pair", {"P1": {"before": "3", "after": "9", "delta": 6}})
    r = client.get("/admin/export.csv", query_string={"study": "delta-pair"})
    row = next(csv.DictReader(io.StringIO(r.data.decode())))
    assert row["P1_before"] == "3" and row["P1_after"] == "9"
    assert float(row["P1_delta"]) == 6
