"""
SQLite access for the platform.

One connection per request (stored on ``flask.g``) plus a process-wide write lock so
concurrent respondents never trip SQLite's single-writer rule.
"""

from __future__ import annotations

import json
import sqlite3
import threading

from flask import current_app, g

write_lock = threading.Lock()

SCHEMA = """
CREATE TABLE IF NOT EXISTS studies (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    slug TEXT UNIQUE,
    title TEXT,
    status TEXT DEFAULT 'draft',
    cfg TEXT,
    created_at TEXT,
    updated_at TEXT
);
CREATE TABLE IF NOT EXISTS respondents (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    respondent_code TEXT,
    session_id TEXT UNIQUE,
    study_id INTEGER DEFAULT 1,
    is_test INTEGER DEFAULT 0,
    status TEXT DEFAULT 'in_progress',
    screen_out_at TEXT,
    screen_out_reason TEXT,
    started_at TEXT,
    completed_at TEXT,
    elapsed_seconds REAL DEFAULT 0,
    task_order TEXT,
    alt_positions TEXT,
    user_agent TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_resp_code ON respondents(study_id, respondent_code);
CREATE TABLE IF NOT EXISTS answers (
    respondent_id INTEGER,
    question_id TEXT,
    item TEXT,
    value TEXT,
    seconds REAL DEFAULT 0,
    PRIMARY KEY (respondent_id, question_id, item)
);
"""

# Databases created by the pre-Flask server had a global UNIQUE on respondent_code.
MIGRATE_OLD_UNIQUE = """
CREATE TABLE respondents_new (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    respondent_code TEXT,
    session_id TEXT UNIQUE,
    study_id INTEGER DEFAULT 1,
    is_test INTEGER DEFAULT 0,
    status TEXT DEFAULT 'in_progress',
    screen_out_at TEXT,
    screen_out_reason TEXT,
    started_at TEXT,
    completed_at TEXT,
    elapsed_seconds REAL DEFAULT 0,
    task_order TEXT,
    alt_positions TEXT,
    user_agent TEXT
);
INSERT INTO respondents_new
    SELECT id, respondent_code, session_id, study_id, is_test, status,
           screen_out_at, screen_out_reason, started_at, completed_at,
           elapsed_seconds, task_order, alt_positions, user_agent
    FROM respondents;
DROP TABLE respondents;
ALTER TABLE respondents_new RENAME TO respondents;
CREATE UNIQUE INDEX ux_resp_code ON respondents(study_id, respondent_code);
"""


def connect(path: str | None = None) -> sqlite3.Connection:
    conn = sqlite3.connect(path or current_app.config["DB_PATH"], timeout=30,
                           check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    return conn


def get_db() -> sqlite3.Connection:
    """Request-scoped connection."""
    if "db" not in g:
        g.db = connect()
    return g.db


def close_db(_exc=None) -> None:
    conn = g.pop("db", None)
    if conn is not None:
        conn.close()


def init_db(path: str | None = None) -> None:
    conn = connect(path)
    try:
        with conn:
            conn.executescript(SCHEMA)
            cols = {r["name"] for r in conn.execute("PRAGMA table_info(respondents)")}
            if "study_id" not in cols:
                conn.execute("ALTER TABLE respondents ADD COLUMN study_id INTEGER DEFAULT 1")
            if "is_test" not in cols:
                conn.execute("ALTER TABLE respondents ADD COLUMN is_test INTEGER DEFAULT 0")
            tbl_sql = conn.execute(
                "SELECT sql FROM sqlite_master WHERE type='table' AND name='respondents'"
            ).fetchone()[0]
            if "respondent_code TEXT UNIQUE" in tbl_sql:
                conn.executescript(MIGRATE_OLD_UNIQUE)
    finally:
        conn.close()


# ---------------------------------------------------------------- study helpers
def study_row(slug: str, conn: sqlite3.Connection | None = None):
    conn = conn or get_db()
    return conn.execute("SELECT * FROM studies WHERE slug=?", (slug,)).fetchone()


def study_by_id(study_id: int, conn: sqlite3.Connection | None = None):
    conn = conn or get_db()
    return conn.execute("SELECT * FROM studies WHERE id=?", (study_id,)).fetchone()


def study_cfg(row) -> dict:
    return json.loads(row["cfg"]) if row and row["cfg"] else {}


def cfg_of(slug: str) -> dict:
    return study_cfg(study_row(slug))


def all_answers_for(conn: sqlite3.Connection, rid: int) -> dict:
    rows = conn.execute("SELECT question_id, item, value FROM answers WHERE respondent_id=?",
                        (rid,))
    out: dict = {}
    for r in rows:
        out.setdefault(r["question_id"], {})
        if r["item"] in ("codes", "order"):
            try:
                out[r["question_id"]][r["item"]] = json.loads(r["value"])
            except (json.JSONDecodeError, TypeError):
                out[r["question_id"]][r["item"]] = []
        else:
            out[r["question_id"]][r["item"]] = r["value"]
    return out


def init_app(app) -> None:
    app.teardown_appcontext(close_db)
