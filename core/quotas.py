"""
Quota cells - how many completed responses each option group of a question needs.

A study configures quotas in the Studio's Quota tab as a list under ``cfg["quotas"]``::

    "quotas": [
        {"id": "qc1", "qid": "Q1", "options": ["1"],   "target": 2},   # Medical Oncologist
        {"id": "qc2", "qid": "Q1", "options": ["2"],   "target": 4},   # Hem Oncologist
        {"id": "qc3", "qid": "Q1", "options": ["3"],   "target": 4}    # Surgeons
    ]

Each cell counts **completed** responses whose answer to ``qid`` includes one of the
cell's option codes (``single_select`` answers the code directly, ``multi_select``
answers a list of codes).  Test runs never fill a quota unless the study turns on
``quotas_count_test`` (a rehearsal switch in the Quota tab).

When a cell reaches its target the team is told to stop sharing new respondent links
for that option.  Respondents who arrive afterwards are still allowed to complete -
their response is simply categorised ``"Quota Full"`` in the data extracts (the same
files as always; no separate quota export).  The category of a response is the number
of *earlier* completes in the cells it matches: the first ``target`` completes are
within quota, everyone after is "Quota Full".

This module is the single source of truth for that rule; the Studio API, the live
fill status and the export columns all read it.  (Note: the legacy ``cfg["quota"]``
practice-setting mapping in reporting is unrelated and untouched.)
"""

from __future__ import annotations

CATEGORY = "Quota Full"
COUNTABLE = ("single_select", "multi_select")


# ------------------------------------------------------------------ config
def normalize(cfg: dict) -> list[dict]:
    """Validated quota cells from the config - ids, codes and targets cleaned up."""
    out = []
    for i, raw in enumerate(cfg.get("quotas") or []):
        if not isinstance(raw, dict):
            continue
        qid = str(raw.get("qid") or "").strip()
        try:
            target = int(raw.get("target") or 0)
        except (TypeError, ValueError):
            target = 0
        options = [str(o).strip() for o in (raw.get("options") or []) if str(o).strip() != ""]
        if not qid or not options or target < 1:
            continue
        out.append({"id": str(raw.get("id") or f"qc{i + 1}"), "qid": qid,
                    "options": options, "target": target})
    return out


def count_test(cfg: dict) -> bool:
    return bool(cfg.get("quotas_count_test"))


def question_of(cfg: dict, qid: str) -> dict | None:
    for q in cfg.get("questions", []):
        if str(q.get("id")) == str(qid):
            return q
    return None


def eligible(q: dict | None) -> bool:
    """Quota cells work on questions with discrete options - typically screeners."""
    return bool(q) and q.get("type") in COUNTABLE and bool(q.get("options"))


def matches(cell: dict, q: dict | None, answers: dict) -> bool:
    """Does this response fall into the cell's option group?"""
    if not eligible(q):
        return False
    a = answers.get(str(cell["qid"])) or answers.get(cell["qid"]) or {}
    if not isinstance(a, dict):
        return False
    want = set(cell["options"])
    if q.get("type") == "multi_select":
        return bool(want & {str(c) for c in (a.get("codes") or [])})
    return str(a.get("_", "")) in want


# ------------------------------------------------------------------ counting
def _counted(rows: list[dict], count_test_runs: bool) -> list[dict]:
    """Completed responses that may fill quotas, in fill order."""
    ok = [r for r in rows
          if r.get("status") == "complete" and (count_test_runs or not r.get("is_test"))]
    return sorted(ok, key=lambda r: (r.get("completed_at") or "", r.get("id") or 0))


def evaluate(cfg: dict, rows: list[dict]) -> dict:
    """Map every counted response to the cells it fills and whether it is over quota.

    ``rows`` needs ``id``, ``is_test``, ``status``, ``completed_at`` and ``answers``.
    Returns ``{"cells": {cell_id: {"matches": [ids in fill order], "over": [ids]}}}``
    and ``"over": {respondent_id: [cell ids it overflowed]}``.
    """
    cells = normalize(cfg)
    universe = _counted(rows, count_test(cfg))
    by_id = {r["id"]: r for r in rows}
    per_cell: dict[str, dict] = {c["id"]: {"matches": [], "over": []} for c in cells}
    over: dict[int, list[str]] = {}
    for c in cells:
        q = question_of(cfg, c["qid"])
        for r in universe:
            if not matches(c, q, r.get("answers") or {}):
                continue
            per_cell[c["id"]]["matches"].append(r["id"])
            if len(per_cell[c["id"]]["matches"]) > c["target"]:
                per_cell[c["id"]]["over"].append(r["id"])
                over.setdefault(r["id"], []).append(c["id"])
    return {"cells": per_cell, "over": over, "universe": universe, "by_id": by_id}


def category_of(ev: dict, respondent_id: int) -> str:
    return CATEGORY if respondent_id in ev["over"] else ""


def attach(recs: list[dict], cfg: dict) -> None:
    """Stamp ``quota_category`` onto every record (top level and its flat row)."""
    ev = evaluate(cfg, recs)
    for rec in recs:
        cat = category_of(ev, rec.get("id"))
        rec["quota_category"] = cat
        if isinstance(rec.get("flat"), dict):
            rec["flat"]["quota_category"] = cat


# ------------------------------------------------------------------ live status
def state(cfg: dict, rows: list[dict]) -> dict:
    """Everything the Studio's Quota tab shows: fill status and the notice log."""
    cells = normalize(cfg)
    ev = evaluate(cfg, rows)
    by_id, universe = ev["by_id"], ev["universe"]
    out_cells, notices = [], []
    total_target = total_filled = 0
    for c in cells:
        q = question_of(cfg, c["qid"])
        m, over_ids = ev["cells"][c["id"]]["matches"], ev["cells"][c["id"]]["over"]
        filled = min(len(m), c["target"])
        full = len(m) >= c["target"]
        opts = [{ "code": str(o.get("code")), "label": o.get("label") or ""}
                for o in (q.get("options") if q else [])
                if str(o.get("code")) in set(c["options"])]
        total_target += c["target"]
        total_filled += filled
        filled_at = ""
        if full and len(m) >= c["target"]:
            filled_at = (by_id.get(m[c["target"] - 1]) or {}).get("completed_at") or ""
        out_cells.append({
            "id": c["id"], "qid": c["qid"], "target": c["target"],
            "question": (q or {}).get("stem") or c["qid"],
            "type": (q or {}).get("type") or "",
            "options": opts,
            "option_labels": ", ".join(o["label"] or o["code"] for o in opts) or c["qid"],
            "filled": filled, "matched": len(m), "remaining": max(0, c["target"] - filled),
            "full": full, "over": len(over_ids), "filled_at": filled_at,
        })
        if full:
            notices.append({
                "kind": "filled", "cell_id": c["id"], "at": filled_at,
                "message": (f"Quota filled: {out_cells[-1]['option_labels']} "
                            f"({filled}/{c['target']}) - stop sharing new respondent "
                            f"links for this option. Later responses are still accepted "
                            f"and saved as \u201c{CATEGORY}\u201d in the data extract."),
            })
    # newest over-quota completes first: the team sees what arrived after the cut
    over_recs = []
    for rid, cell_ids in sorted(ev["over"].items(),
                                key=lambda kv: ((by_id.get(kv[0]) or {}).get("completed_at") or ""),
                                reverse=True):
        r = by_id.get(rid) or {}
        over_recs.append({"respondent_code": r.get("respondent_code"),
                          "is_test": bool(r.get("is_test")),
                          "completed_at": r.get("completed_at") or "",
                          "cells": cell_ids})
    for rec in over_recs[:5]:
        notices.append({
            "kind": "over", "at": rec["completed_at"],
            "message": (f"{rec['respondent_code']} completed over quota "
                        f"({rec['completed_at']}) - saved as \u201c{CATEGORY}\u201d "
                        f"in the data extract."),
        })
    return {
        "cells": out_cells,
        "notifications": notices,
        "over": over_recs,
        "total_target": total_target,
        "total_filled": total_filled,
        "count_test": count_test(cfg),
        "category": CATEGORY,
    }
