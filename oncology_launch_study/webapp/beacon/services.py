"""
Business logic shared by the blueprints: loading respondent records, starting and
persisting sessions, saving studies. Blueprints stay thin; this module owns the SQL.
"""

from __future__ import annotations

import json
import re
import secrets
import time

from .conjoint import assignment_for
from .db import (all_answers_for, cfg_of, get_db, study_by_id, study_cfg, study_row,
                 write_lock)
from .qc import qc_flags
from .reporting import flatten
from .seed import load_task_map

SLUG_RE = re.compile(r"[a-z0-9\-]{2,40}")


def now() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%S")


# ---------------------------------------------------------------- records
def records_for(slug: str, scope: str = "all") -> list:
    """All respondents of a study (with answers + flattened row), filtered by scope."""
    conn = get_db()
    srow = study_row(slug, conn)
    sid = srow["id"] if srow else -1
    cfg = study_cfg(srow)
    rows = conn.execute("SELECT * FROM respondents WHERE study_id=? ORDER BY id",
                        (sid,)).fetchall()
    out = []
    for r in rows:
        if scope == "real" and r["is_test"]:
            continue
        if scope == "test" and not r["is_test"]:
            continue
        rec = {k: r[k] for k in r.keys()}
        rec["answers"] = all_answers_for(conn, r["id"])
        rec["is_test_label"] = "test" if r["is_test"] else "real"
        rec["flat"] = flatten(rec, rec["answers"], cfg)
        out.append(rec)
    return out


# ---------------------------------------------------------------- respondent lifecycle
class StudyError(Exception):
    def __init__(self, message: str, status: int = 400):
        super().__init__(message)
        self.message, self.status = message, status


def start_session(slug: str, is_test: bool, user_agent: str = "") -> dict:
    conn = get_db()
    srow = study_row(slug, conn)
    if not srow:
        raise StudyError("unknown study", 404)
    if srow["status"] != "live":
        raise StudyError("study not live", 403)
    cfg = study_cfg(srow)
    sid = secrets.token_urlsafe(16)
    prefix = "T" if is_test else "R"
    with write_lock, conn:
        row = conn.execute(
            "SELECT MAX(CAST(SUBSTR(respondent_code,2) AS INTEGER)) AS m FROM respondents "
            "WHERE study_id=? AND respondent_code LIKE ?", (srow["id"], prefix + "%")
        ).fetchone()
        code = f"{prefix}{(row['m'] or 0) + 1:03d}"
        conn.execute(
            "INSERT INTO respondents (respondent_code, session_id, study_id, is_test, "
            "started_at, user_agent) VALUES (?,?,?,?,?,?)",
            (code, sid, srow["id"], int(is_test), now(), (user_agent or "")[:300]))
    design = cfg.get("conjoint")
    task_map = load_task_map() if slug == "beacon" else None
    assignment = (assignment_for(code, design, task_map) if design
                  else {"task_order": [], "alt_positions": {}})
    with write_lock, conn:
        conn.execute("UPDATE respondents SET task_order=?, alt_positions=? WHERE session_id=?",
                     (json.dumps(assignment["task_order"]),
                      json.dumps(assignment["alt_positions"]), sid))
    return {"session_id": sid, "respondent_code": code, "is_test": bool(is_test),
            "study": slug, "task_order": assignment["task_order"],
            "alt_positions": assignment["alt_positions"],
            "from_prebuilt_map": code in (task_map or {})}


def resolve_session(session_id: str | None):
    if not session_id:
        return None
    return get_db().execute("SELECT * FROM respondents WHERE session_id=?",
                            (session_id,)).fetchone()


def persist_answers(body: dict):
    """Upsert answers + timing for a session. Returns (status, respondent_id) or None."""
    row = resolve_session(body.get("session_id"))
    if row is None:
        return None
    rid = row["id"]
    seconds = float(body.get("elapsed_seconds") or 0)
    status = "screened_out" if body.get("screened_out") else row["status"]
    conn = get_db()
    with write_lock, conn:
        for qid, payload in (body.get("answers") or {}).items():
            if not isinstance(payload, dict):
                continue
            for item, val in payload.items():
                conn.execute(
                    "INSERT INTO answers (respondent_id, question_id, item, value, seconds) "
                    "VALUES (?,?,?,?,?) ON CONFLICT(respondent_id, question_id, item) "
                    "DO UPDATE SET value=excluded.value, seconds=excluded.seconds",
                    (rid, qid, item,
                     json.dumps(val) if isinstance(val, list) else str(val), seconds))
        conn.execute("UPDATE respondents SET elapsed_seconds=?, status=?, screen_out_at=?, "
                     "screen_out_reason=? WHERE id=?",
                     (seconds, status, body.get("screen_out_at") or row["screen_out_at"],
                      body.get("screen_out_reason") or row["screen_out_reason"], rid))
    return status, rid


def complete_session(body: dict) -> dict | None:
    result = persist_answers(body)
    if result is None:
        return None
    _status, rid = result
    seconds = float(body.get("elapsed_seconds") or 0)
    conn = get_db()
    with write_lock, conn:
        conn.execute("UPDATE respondents SET status='complete', completed_at=?, "
                     "elapsed_seconds=? WHERE id=?", (now(), seconds, rid))
    r = conn.execute("SELECT * FROM respondents WHERE id=?", (rid,)).fetchone()
    answers = all_answers_for(conn, rid)
    cfg = study_cfg(study_by_id(r["study_id"], conn))
    return {"ok": True, "respondent_code": r["respondent_code"],
            **qc_flags(answers, seconds, cfg)}


def progress_for(session_id: str | None) -> dict:
    row = resolve_session(session_id)
    if row is None:
        return {"exists": False}
    answers = all_answers_for(get_db(), row["id"])
    return {"exists": True, "respondent_code": row["respondent_code"],
            "status": row["status"], "is_test": bool(row["is_test"]), "answers": answers,
            "task_order": json.loads(row["task_order"] or "[]"),
            "alt_positions": json.loads(row["alt_positions"] or "{}"),
            "elapsed_seconds": row["elapsed_seconds"]}


def spec_for(slug: str) -> dict | None:
    from .survey_spec import TERMINATE_TEXT
    row = study_row(slug)
    if not row:
        return None
    cfg = study_cfg(row)
    conj = cfg.get("conjoint")
    if conj and isinstance(conj.get("tasks"), list):
        # the respondent engine addresses tasks by string key
        conj = dict(conj, tasks={str(i + 1): t for i, t in enumerate(conj["tasks"])})
    return {
        "sections": cfg.get("sections", []),
        "questions": cfg.get("questions", []),
        "conjoint": conj,
        "terminate_text": TERMINATE_TEXT,
        "narration": cfg.get("narration", {}),
        "explainer_scenes": cfg.get("explainer_scenes", []),
        "conjoint_scene": cfg.get("conjoint_scene"),
        "conjoint_min_dwell": cfg.get("conjoint_min_dwell", 12),
        "use_tts": cfg.get("use_tts", False),
        "tpp": cfg.get("tpp", {}),
    }


# ---------------------------------------------------------------- studio
def list_studies() -> list:
    rows = get_db().execute(
        "SELECT s.id, s.slug, s.title, s.status, s.updated_at, "
        "(SELECT COUNT(*) FROM respondents r WHERE r.study_id=s.id) AS n, "
        "(SELECT COUNT(*) FROM respondents r WHERE r.study_id=s.id AND "
        "r.status='complete') AS c FROM studies s ORDER BY s.id").fetchall()
    return [{"slug": r["slug"], "title": r["title"], "status": r["status"],
             "updated_at": r["updated_at"], "started": r["n"], "complete": r["c"]}
            for r in rows]


def save_study(body: dict) -> str:
    cfg = body.get("cfg") or {}
    title = str(body.get("title") or cfg.get("title") or "Untitled study")[:120]
    slug = str(body.get("slug") or "").lower().strip()
    if not SLUG_RE.fullmatch(slug):
        slug = re.sub(r"[^a-z0-9\-]+", "-", title.lower()).strip("-")[:40] or "study"
    cfg["title"] = title
    ids = [q.get("id") for q in cfg.get("questions", [])]
    if len(ids) != len(set(ids)):
        raise StudyError("duplicate question ids")
    sec_ids = {s.get("id") for s in cfg.get("sections", [])}
    if any(q.get("section") not in sec_ids for q in cfg.get("questions", [])):
        raise StudyError("question references unknown section")
    conn = get_db()
    ts = now()
    with write_lock, conn:
        if study_row(slug, conn):
            conn.execute("UPDATE studies SET title=?, cfg=?, updated_at=? WHERE slug=?",
                         (title, json.dumps(cfg), ts, slug))
        else:
            conn.execute("INSERT INTO studies (slug, title, status, cfg, created_at, "
                         "updated_at) VALUES (?,?,?,?,?,?)",
                         (slug, title, "draft", json.dumps(cfg), ts, ts))
    return slug


def set_status(slug: str, status: str) -> None:
    if status not in ("draft", "live", "closed"):
        raise StudyError("bad status")
    conn = get_db()
    with write_lock, conn:
        conn.execute("UPDATE studies SET status=?, updated_at=? WHERE slug=?",
                     (status, now(), slug))


def delete_study(slug: str) -> None:
    if slug == "beacon":
        raise StudyError("the seeded beacon study cannot be deleted")
    conn = get_db()
    with write_lock, conn:
        row = study_row(slug, conn)
        if row:
            conn.execute("DELETE FROM answers WHERE respondent_id IN "
                         "(SELECT id FROM respondents WHERE study_id=?)", (row["id"],))
            conn.execute("DELETE FROM respondents WHERE study_id=?", (row["id"],))
            conn.execute("DELETE FROM studies WHERE id=?", (row["id"],))


def reset_respondents(slug: str, scope: str) -> int:
    if scope not in ("test", "real", "all"):
        raise StudyError("scope must be test, real or all")
    conn = get_db()
    with write_lock, conn:
        srow = study_row(slug, conn)
        sid = srow["id"] if srow else -1
        if scope == "all":
            conn.execute("DELETE FROM answers WHERE respondent_id IN "
                         "(SELECT id FROM respondents WHERE study_id=?)", (sid,))
            return conn.execute("DELETE FROM respondents WHERE study_id=?", (sid,)).rowcount
        want = 1 if scope == "test" else 0
        ids = [r["id"] for r in conn.execute(
            "SELECT id FROM respondents WHERE study_id=? AND is_test=?", (sid, want))]
        if ids:
            q = ",".join("?" * len(ids))
            conn.execute(f"DELETE FROM answers WHERE respondent_id IN ({q})", ids)
            conn.execute(f"DELETE FROM respondents WHERE id IN ({q})", ids)
        return len(ids)


__all__ = ["records_for", "start_session", "persist_answers", "complete_session",
           "progress_for", "spec_for", "list_studies", "save_study", "set_status",
           "delete_study", "reset_respondents", "StudyError", "cfg_of"]
