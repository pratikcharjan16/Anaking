"""Quota cells - filling an option group's quota, and what happens after it is full.

The Quota tab lets the team say "Q1 Medical Oncologist needs 2 completes, Hem Onc 4,
Surgeons 4".  When a group reaches its target the team is told to stop sharing new
respondent links for that option.  Respondents who arrive after that are still allowed
to complete (no blocking) - their response is saved as "Quota Full" in the normal data
extract, never a separate file.  And in every case the team is notified.
"""

import copy

from core.quotas import CATEGORY, attach, state
from routes.helpers import records

CFG = {
    "language": "en-US",
    "sections": [{"id": "S1", "title": "Screeners"}],
    "questions": [
        {"id": "Q1", "section": "S1", "type": "single_select", "stem": "Primary specialty",
         "options": [{"code": 1, "label": "Medical Oncologist"},
                     {"code": 2, "label": "Hem Oncologist"},
                     {"code": 3, "label": "Surgeons"}]},
        {"id": "Q2", "section": "S1", "type": "multi_select", "stem": "Treats",
         "options": [{"code": "a", "label": "Lung"}, {"code": "b", "label": "Breast"},
                     {"code": "c", "label": "GI"}]},
    ],
    "quotas": [
        {"id": "qc1", "qid": "Q1", "options": ["1"], "target": 2},
        {"id": "qc2", "qid": "Q1", "options": ["2"], "target": 4},
        {"id": "qc3", "qid": "Q1", "options": ["3"], "target": 4},
    ],
}


def make(client, slug="quota-study", cfg=None):
    r = client.post("/api/studio/save", json={"slug": slug, "title": slug,
                                             "cfg": copy.deepcopy(cfg or CFG)})
    assert r.status_code == 200, r.get_json()
    r = client.post("/api/studio/status", json={"slug": slug, "status": "live"})
    assert r.status_code == 200, r.get_json()
    return slug


def complete(client, slug, answers, is_test=False):
    """Start a run and submit it as a complete - the flow the survey page drives."""
    r = client.post("/api/start", json={"study": slug, "is_test": is_test})
    assert r.status_code == 200, r.get_json()
    r = client.post("/api/submit", json={"session_id": r.get_json()["session_id"],
                                         "answers": answers, "elapsed_seconds": 90})
    assert r.status_code == 200, r.get_json()
    return r.get_json()


def state_of(client, slug):
    r = client.get("/api/studio/quotas", query_string={"slug": slug})
    assert r.status_code == 200, r.get_json()
    return r.get_json()


# ------------------------------------------------------------------ fill counting
def test_quota_cells_fill_from_completed_responses(client):
    slug = make(client)
    for code in (1, 1, 2):                       # 2x Medical Onc, 1x Hem Onc
        complete(client, slug, {"Q1": {"_": code}, "Q2": {"codes": []}})

    st = state_of(client, slug)
    by = {c["id"]: c for c in st["cells"]}
    assert (by["qc1"]["filled"], by["qc1"]["full"]) == (2, True)      # 2/2 - stop links
    assert (by["qc2"]["filled"], by["qc2"]["full"]) == (1, False)     # 1/4 still filling
    assert (by["qc3"]["filled"], by["qc3"]["full"]) == (0, False)
    assert st["total_target"] == 10 and st["total_filled"] == 3
    # the question and its options are named for the notice the team reads
    assert by["qc1"]["question"] == "Primary specialty"
    assert by["qc1"]["option_labels"] == "Medical Oncologist"


def test_team_is_notified_when_a_quota_fills(client):
    slug = make(client)
    for _ in range(2):
        complete(client, slug, {"Q1": {"_": 1}, "Q2": {"codes": []}})
    st = state_of(client, slug)
    kinds = [n["kind"] for n in st["notifications"]]
    assert "filled" in kinds
    filled = [n for n in st["notifications"] if n["kind"] == "filled"][0]
    assert "stop sharing" in filled["message"] and "Medical Oncologist" in filled["message"]


def test_over_quota_responses_still_complete_and_are_tagged_quota_full(client):
    slug = make(client)
    for _ in range(2):                                    # qc1 now full (2/2)
        complete(client, slug, {"Q1": {"_": 1}, "Q2": {"codes": []}})

    # a third Medical Oncologist arrives after the cut - allowed to complete
    done = complete(client, slug, {"Q1": {"_": 1}, "Q2": {"codes": []}})
    assert done["ok"] is True and done["respondent_code"]

    st = state_of(client, slug)
    assert [o["is_test"] for o in st["over"]] == [False]
    assert st["over"][0]["cells"] == ["qc1"]
    # and the team hears about it too - every case is notified
    assert any(n["kind"] == "over" and "Quota Full" in n["message"] for n in st["notifications"])


def test_extract_tags_quota_full_in_the_normal_files_not_a_separate_one(client, app):
    slug = make(client)
    for _ in range(2):
        complete(client, slug, {"Q1": {"_": 1}, "Q2": {"codes": []}})
    complete(client, slug, {"Q1": {"_": 1}, "Q2": {"codes": []}})     # over
    complete(client, slug, {"Q1": {"_": 2}, "Q2": {"codes": []}})     # within

    with app.app_context():
        rows = records(slug, "all")
    cats = sorted(r["flat"].get("quota_category") or "" for r in rows)
    assert cats == ["", "", "", CATEGORY]          # 3 within quota, 1 over (of 4 completes)
    by_ans = {str(r["answers"]["Q1"]["_"]): r for r in rows}
    assert by_ans["2"]["flat"]["quota_category"] == ""                # within quota
    assert by_ans["1"]["flat"]["quota_category"] == CATEGORY

    # the column rides in the existing CSV extract (no separate quota export exists)
    csv_data = client.get("/admin/export.csv",
                          query_string={"study": slug, "scope": "all"}).data.decode()
    header = csv_data.splitlines()[0]
    assert "quota_category" in header
    assert CATEGORY in csv_data


def test_multi_select_quota_counts_codes(client):
    cfg = copy.deepcopy(CFG)
    cfg["quotas"] = [{"id": "qc9", "qid": "Q2", "options": ["b", "c"], "target": 1}]
    slug = make(client, cfg=cfg)
    complete(client, slug, {"Q1": {"_": 1}, "Q2": {"codes": ["a", "b"]}})      # matches b
    st = state_of(client, slug)
    assert st["cells"][0]["full"] is True
    complete(client, slug, {"Q1": {"_": 1}, "Q2": {"codes": ["c"]}})           # over
    st = state_of(client, slug)
    assert st["cells"][0]["over"] == 1


def test_test_runs_do_not_fill_quotas_unless_asked(client):
    slug = make(client)
    for _ in range(3):
        complete(client, slug, {"Q1": {"_": 1}, "Q2": {"codes": []}}, is_test=True)
    st = state_of(client, slug)
    assert st["cells"][0]["filled"] == 0 and st["cells"][0]["full"] is False

    # flip the rehearsal switch and the test runs count
    cfg = copy.deepcopy(CFG)
    cfg["quotas_count_test"] = True
    make(client, slug, cfg)
    st = state_of(client, slug)
    assert st["cells"][0]["filled"] == 2 and st["cells"][0]["full"] is True


# ------------------------------------------------------------------ engine unit level
def test_normalize_drops_incomplete_cells_and_reads_clean_ones():
    cfg = {"questions": CFG["questions"], "quotas": [
        {"id": "x", "qid": "Q1", "options": [], "target": 5},          # no options
        {"id": "y", "qid": "Q1", "options": ["1"], "target": 0},       # no target
        {"id": "z", "qid": "Q1", "options": [1, " 2 "], "target": "3"}, {"id": "w", "qid": "Q9", "options": ["1"], "target": 1}]}
    cells = state(cfg, [])["cells"]
    assert [(c["id"], [o["code"] for o in c["options"]], c["target"]) for c in cells] \
        == [("z", ["1", "2"], 3), ("w", [], 1)]


def test_only_first_target_completes_are_within_quota():
    cfg = {"questions": CFG["questions"],
           "quotas": [{"id": "qc1", "qid": "Q1", "options": ["1"], "target": 2}]}
    rows = [{"id": i, "is_test": False, "status": "complete", "flat": {},
             "completed_at": f"2026-10-22 10:0{i}", "answers": {"Q1": {"_": 1}}}
            for i in range(1, 4)]
    rows.append({"id": 9, "is_test": False, "status": "partial", "flat": {},
                 "completed_at": "2026-10-22 10:09", "answers": {"Q1": {"_": 1}}})
    attach(rows, cfg)
    cats = [r["quota_category"] for r in rows]
    assert cats == ["", "", CATEGORY, ""]                  # partials never count either
    assert all(r["flat"]["quota_category"] == r["quota_category"] for r in rows)
