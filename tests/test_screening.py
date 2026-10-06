"""
Screening (screen in / screen out) - the server-side half.

The rules themselves are executed in the browser (BeaconQ.screeningVerdict in
static/js/qlogic.js, covered by scripts/dom/screening_engine_test.js).  These tests
cover what Python owns: the config is cleaned on save, the legacy shorthand still
reads, and the rules are written into the Word outline and the Excel data dictionary
in plain English.
"""

import io
import zipfile

from core import screening
from core.outline import build_outline
from core.reporting import build_sheets

SINGLE = {
    "id": "Q1", "section": "S1", "type": "single_select", "stem": "Specialty",
    "options": [{"code": 1, "label": "Medical oncology"},
                {"code": 2, "label": "Radiation oncology", "terminate": True}],
}
NUMERIC = {
    "id": "Q3", "section": "S1", "type": "numeric", "stem": "Patients per month",
    "screening": {"enabled": True, "mode": "screen_out", "match": "all", "when": "next",
                  "reason": "Haematology-only, low volume",
                  "rules": [{"q": "Q1", "op": "selected", "value": 4},
                            {"q": "Q3", "op": "lt", "value": 10}]},
}
CFG = {"title": "Screening study",
       "sections": [{"id": "S1", "title": "Screeners"}],
       "questions": [SINGLE, NUMERIC]}


# ---------------------------------------------------------------- normalise on save
def test_empty_or_broken_blocks_are_dropped():
    q = {"id": "Q1", "screening": {"mode": "screen_out", "rules": []}}
    screening.normalize(q)
    assert "screening" not in q

    q = {"id": "Q1", "screening": {"rules": [{"op": "selected"}, {"nonsense": 1}]}}
    screening.normalize(q)
    assert "screening" not in q                      # a rule without a question is unusable

    q = {"id": "Q1", "screening": "screen out everyone"}
    screening.normalize(q)
    assert "screening" not in q


def test_a_saved_block_is_cleaned_to_exactly_the_stored_shape():
    q = {"id": "Q1", "screening": {"mode": "nonsense", "match": "any", "when": "whenever",
                                   "junk": True, "message": "  Sorry  ",
                                   "rules": [{"q": "Q1", "op": "any_of", "value": "2,3"},
                                             "not a rule"]}}
    screening.normalize(q)
    s = q["screening"]
    assert s["mode"] == "screen_out"                 # unknown values fall back, never break
    assert s["match"] == "any" and s["when"] == "live"
    assert s["message"] == "Sorry" and "junk" not in s
    assert s["rules"] == [{"q": "Q1", "op": "any_of", "value": "2,3"}]


# ---------------------------------------------------------------- legacy shorthand
def test_options_marked_terminate_are_still_read():
    blocks = screening.blocks(dict(SINGLE))
    assert len(blocks) == 1 and blocks[0]["mode"] == "screen_out"
    assert blocks[0]["rules"] == [{"q": "Q1", "op": "selected", "value": 2}]


def test_terminate_if_lt_is_still_read():
    q = {"id": "Q3", "type": "numeric", "terminate_if_lt": 5, "terminate_message": "Thanks"}
    blocks = screening.blocks(q)
    assert blocks[0]["rules"] == [{"q": "Q3", "op": "lt", "value": 5}]
    assert blocks[0]["when"] == "next"               # never fires while the box is half typed


def test_authored_rules_and_legacy_options_both_count():
    q = dict(SINGLE)
    q["screening"] = {"mode": "qualify", "match": "all",
                      "rules": [{"q": "Q1", "op": "none_of", "value": "1"}]}
    blocks = screening.blocks(q)
    assert [b["mode"] for b in blocks] == ["qualify", "screen_out"]


# ---------------------------------------------------------------- plain English
def test_describe_reads_as_a_sentence():
    assert screening.describe(NUMERIC, [SINGLE, NUMERIC]) == [
        "screen out when Q1 is 4 and Q3 < 10"]
    assert screening.describe(SINGLE, [SINGLE, NUMERIC]) == [
        "screen out when Q1 is Radiation oncology"]


def test_describe_uses_option_labels_not_codes():
    q = {**SINGLE, "options": [dict(o) for o in SINGLE["options"]]}
    q["options"][1].pop("terminate")             # a copy without the legacy switch
    q["screening"] = {"mode": "screen_out", "match": "any",
                      "rules": [{"q": "Q1", "op": "any_of", "value": "1,2"}]}
    assert screening.describe(q, [SINGLE]) == [
        "screen out when Q1 is any of Medical oncology, Radiation oncology"]


# ---------------------------------------------------------------- it reaches the documents
def test_the_word_outline_shows_the_screening_rules():
    data = build_outline(CFG)
    with zipfile.ZipFile(io.BytesIO(data)) as z:
        doc = z.read("word/document.xml").decode("utf-8")
    assert "screen out when Q1 is Radiation oncology" in doc
    assert "screen out when Q1 is 4 and Q3 &lt; 10" in doc


def test_the_data_dictionary_shows_the_screening_rules():
    sheets = build_sheets([], "all", CFG)
    dd = next(rows for name, headers, rows, _ in sheets if name == "Data dictionary")
    lines = [r[5] for r in dd if r[4] == "(screening)"]
    assert lines == ["screen out when Q1 is Radiation oncology",
                     "screen out when Q1 is 4 and Q3 < 10"]
