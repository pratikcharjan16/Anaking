"""
Screening (screen in / screen out) - the server-side half.

The rules are *executed* in the browser by ``BeaconQ.screeningVerdict``
(static/js/qlogic.js), so a respondent is screened out the moment they answer.
This module owns everything that happens on the server instead:

    normalize(q)   clean a question's screening block on save, so hand-edited JSON
                   (the Advanced card) can never put the runtime into a bad state
    blocks(q)      the screening blocks of a question, explicit rules first, then the
                   legacy shorthand (options[].terminate, terminate_if_lt)
    describe(q)    the same rules in plain English, for the Word outline and the
                   data dictionary in the Excel export

A question carries at most one authored block::

    screening: { mode:  "screen_out" | "qualify",
                 match: "all" | "any",
                 when:  "live" | "next",
                 message: "what the respondent reads when it fires",
                 reason:  "short line recorded in the screen-out report",
                 rules: [ {q: "Q1", op: "any_of", value: "5,6,7,8"} ] }

``screen_out`` ends the survey when the rules match; ``qualify`` ends it for
everybody the rules do *not* match.
"""

from __future__ import annotations

MODES = ("screen_out", "qualify")
WHEN = ("live", "next")

# operator -> plain words, for the outline and the data dictionary
OP_WORDS = {
    "selected": "is", "not_selected": "is not",
    "any_of": "is any of", "none_of": "is none of",
    "all_of": "includes all of", "exactly": "is exactly",
    "count_gte": "selects at least", "count_lte": "selects at most",
    "count_eq": "selects exactly",
    # numbers read as the operator itself: "Q3 < 10"
    "eq": "=", "ne": "\u2260", "gt": ">", "gte": "\u2265", "lt": "<", "lte": "\u2264",
    "between": "is between", "not_between": "is outside",
    "contains": "mentions", "not_contains": "does not mention",
    "words_lt": "is shorter than",
    # rows, groups of rows and totals (constant sum / numeric matrix)
    "row_eq": "row =", "row_ne": "row \u2260", "row_gte": "row \u2265", "row_lte": "row \u2264",
    "row_gt": "row >", "row_lt": "row <",
    "sum_of_gte": "share \u2265", "sum_of_lte": "share \u2264",
    "total_eq": "total =", "total_ne": "total \u2260", "total_gte": "total \u2265",
    "total_lte": "total \u2264",
    "ranked_first": "ranks first", "ranked_top": "ranks in the top",
    "answered": "was answered", "not_answered": "was skipped",
}


def _codes(value) -> list[str]:
    return [str(v).strip() for v in str(value if value is not None else "").split(",")
            if str(v).strip()]


def _label(q: dict, code) -> str:
    for item in (q.get("options") or []) + (q.get("rows") or []):
        if str(item.get("code")) == str(code):
            return str(item.get("label") or code)
    return str(code)


def normalize(q: dict) -> dict:
    """Clean one question's screening block in place. Unknown fields are dropped so
    the stored config always matches what the builder can render."""
    if not isinstance(q, dict):
        return q
    s = q.get("screening")
    if not isinstance(s, dict):
        q.pop("screening", None)
        return q
    rules = [r for r in (s.get("rules") or []) if isinstance(r, dict) and r.get("q") and r.get("op")]
    if not rules:
        q.pop("screening", None)
        return q
    clean = []
    for r in rules:
        item = {"q": str(r.get("q")), "op": str(r.get("op"))}
        if r.get("value") is not None:
            item["value"] = r.get("value")
        clean.append(item)
    out = {
        "enabled": True,
        "mode": s.get("mode") if s.get("mode") in MODES else "screen_out",
        "match": "any" if s.get("match") == "any" else "all",
        "when": s.get("when") if s.get("when") in WHEN else "live",
        "rules": clean,
    }
    for key in ("message", "reason"):
        text = str(s.get(key) or "").strip()
        if text:
            out[key] = text
    q["screening"] = out
    return q


def blocks(q: dict) -> list[dict]:
    """Every screening block of a question: the authored one, then the legacy shorthand."""
    out = []
    if not isinstance(q, dict):
        return out
    s = q.get("screening")
    if isinstance(s, dict) and s.get("enabled") is not False and s.get("rules"):
        out.append({
            "mode": "qualify" if s.get("mode") == "qualify" else "screen_out",
            "match": "any" if s.get("match") == "any" else "all",
            "when": "next" if s.get("when") == "next" else "live",
            "rules": s["rules"], "source": "rules",
        })
    marked = [o for o in (q.get("options") or []) if isinstance(o, dict) and o.get("terminate")]
    if marked:
        out.append({
            "mode": "screen_out", "match": "any", "when": "live", "source": "options",
            "rules": [{"q": q.get("id"), "op": "selected", "value": o.get("code")} for o in marked],
        })
    if q.get("terminate_if_lt") not in (None, ""):
        out.append({
            "mode": "screen_out", "match": "all", "when": "next", "source": "legacy",
            "rules": [{"q": q.get("id"), "op": "lt", "value": q["terminate_if_lt"]}],
        })
    return out


def _rule_text(rule: dict, questions: dict) -> str:
    q = questions.get(str(rule.get("q")), {})
    op = str(rule.get("op") or "")
    word = OP_WORDS.get(op, op)
    value = rule.get("value")
    if op in ("selected", "not_selected", "any_of", "none_of", "all_of", "exactly", "ranked_first"):
        joiner = " and " if op == "all_of" else ", "
        labels = [_label(q, c) for c in _codes(value)]
        value = joiner.join(labels) or "…"
    elif op == "ranked_top":
        head, _, n = str(value or "").partition("=")
        value = f"{_label(q, head)} (top {n})"
    elif op.startswith("row_"):
        head, _, tail = str(value or "").partition("=")
        value = f"{_label(q, head)} {tail}"
    elif op.startswith("sum_of_"):          # "a,b=40" -> what a group of rows adds up to
        head, _, tail = str(value or "").partition("=")
        labels = [_label(q, c) for c in _codes(head)]
        value = f"{' + '.join(labels) or 'the rows'} {tail or 0}"
    elif op in ("between", "not_between"):
        halves = str(value or "").split("-")
        value = " and ".join(halves) if op == "between" else " – ".join(halves)
    elif op == "words_lt":
        value = f"{value} words"
    return f"{rule.get('q')} {word} {value}".strip()


def describe(q: dict, questions: list | None = None) -> list[str]:
    """One plain-English line per screening block, or [] when nothing screens here."""
    index = {str(x.get("id")): x for x in (questions or []) if isinstance(x, dict)}
    index.setdefault(str(q.get("id")), q if isinstance(q, dict) else {})
    out = []
    for b in blocks(q):
        joiner = " or " if b["match"] == "any" else " and "
        text = joiner.join(_rule_text(r, index) for r in b["rules"])
        lead = "continue only when " if b["mode"] == "qualify" else "screen out when "
        out.append(lead + text)
    return out
