"""
The users database — every account-owned row in its own SQLite file.

SurveyKart keeps research data and account data apart on disk:

    data/survey.db    studies, respondents, answers, invites, shares, teams, audit
    data/users.db     users, credentials, Kart ledger, Kart requests, password resets

One connection still sees both. ``models.connect`` ATTACHes the users file as
``udb``, and SQLite resolves an unqualified table name against ``main`` first and
then the attached files — so the account tables are created in ``udb`` and every
existing query (``SELECT * FROM users``, ``INSERT INTO point_transactions …``)
keeps working unchanged, while a backup of ``users.db`` is a complete, portable
copy of who can sign in and what Kart they hold.

Two rules make this safe:

* a fresh install must never create these tables in ``main`` — the DDL below is
  schema-qualified (``udb.users``), so it cannot drift back;
* an install created before the split already has them in ``main`` — :func:`ensure`
  copies those rows across once and drops the legacy tables, so upgrades are
  automatic (see :func:`migrate_from_main`).

A ``:memory:`` database has nowhere to attach to, so it stays single-file: the
alias is skipped and the same DDL runs unqualified.
"""

from __future__ import annotations

import os
import sqlite3

ALIAS = "udb"

#: The account-owned tables. Everything else belongs to the survey database.
TABLES = ("users", "point_transactions", "point_requests", "password_resets")

#: ``{p}`` is the schema prefix (``udb.`` in the split layout, empty in memory).
SCHEMA = """
CREATE TABLE IF NOT EXISTS {p}users (
    id INTEGER PRIMARY KEY,
    email TEXT UNIQUE NOT NULL,
    username TEXT NOT NULL DEFAULT '',
    password_hash TEXT NOT NULL DEFAULT '',
    name TEXT NOT NULL DEFAULT '',
    picture TEXT NOT NULL DEFAULT '',
    google_sub TEXT NOT NULL DEFAULT '',
    role TEXT NOT NULL DEFAULT 'user',
    status TEXT NOT NULL DEFAULT 'pending',
    points_limit INTEGER NOT NULL DEFAULT 100,
    created_at TEXT NOT NULL,
    approved_at TEXT NOT NULL DEFAULT '',
    approved_by TEXT NOT NULL DEFAULT '',
    last_login TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS {p}point_transactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    delta INTEGER NOT NULL,
    balance_after INTEGER NOT NULL,
    reason TEXT NOT NULL DEFAULT '',
    actor TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS {p}ix_pt_tx_user ON point_transactions(user_id, id DESC);

CREATE TABLE IF NOT EXISTS {p}point_requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    requested_points INTEGER NOT NULL,
    reason TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'pending',
    reviewed_by TEXT NOT NULL DEFAULT '',
    reviewed_at TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS {p}ix_pt_req_status ON point_requests(status, id DESC);

-- One-time sign-in recovery. The token is stored hashed: a copy of users.db
-- never hands anyone a working reset link.
CREATE TABLE IF NOT EXISTS {p}password_resets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    token_hash TEXT UNIQUE NOT NULL,
    kind TEXT NOT NULL DEFAULT 'password',
    status TEXT NOT NULL DEFAULT 'pending',
    delivered TEXT NOT NULL DEFAULT '',
    requested_by TEXT NOT NULL DEFAULT '',
    requested_ip TEXT NOT NULL DEFAULT '',
    note TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    used_at TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS {p}ix_resets_user ON password_resets(user_id, id DESC);
CREATE INDEX IF NOT EXISTS {p}ix_resets_status ON password_resets(status, id DESC);
"""


# ====================================================================================
# FILE PLACEMENT
# ====================================================================================
def default_path(main_path: str) -> str:
    """Where the users file lives for a given survey database path."""
    folder = os.path.dirname(os.path.abspath(main_path or "survey.db")) or "."
    return os.path.join(folder, "users.db")


def resolve_path(main_path: str) -> str:
    """The configured users file, else ``users.db`` beside the survey database."""
    configured = ""
    try:
        from flask import current_app
        configured = str(current_app.config.get("USERS_DB_PATH") or "")
    except RuntimeError:                                   # no app context
        pass
    if configured:
        return os.path.abspath(configured)
    return default_path(main_path)


def is_memory(main_path: str) -> bool:
    return not main_path or main_path == ":memory:" or main_path.startswith("file::memory:")


def attach(conn: sqlite3.Connection, main_path: str) -> str:
    """ATTACH the users file and return the schema prefix to use for its tables.

    ``"udb."`` in the normal split layout, ``""`` when there is no file to attach
    to (an in-memory database), in which case the tables live in ``main``.
    """
    if not is_memory(main_path):
        path = resolve_path(main_path)
        os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
        attached = {row[1] for row in conn.execute("PRAGMA database_list").fetchall()}
        if ALIAS not in attached:
            conn.execute(f"ATTACH DATABASE ? AS {ALIAS}", (path,))
            conn.execute(f"PRAGMA {ALIAS}.journal_mode=WAL")
        return ALIAS + "."
    return ""


def path_of(conn: sqlite3.Connection) -> str:
    """The absolute path of the attached users file, or ``""`` when in memory."""
    for row in conn.execute("PRAGMA database_list").fetchall():
        if row[1] == ALIAS:
            return row[2] or ""
    return ""


# ====================================================================================
# SCHEMA + ONE-TIME MIGRATION
# ====================================================================================
def _main_tables(conn: sqlite3.Connection) -> set[str]:
    return {row[0] for row in conn.execute(
        "SELECT name FROM main.sqlite_master WHERE type='table'").fetchall()}


def _columns(conn: sqlite3.Connection, schema_table: str) -> list[str]:
    return [row[1] for row in conn.execute(f"PRAGMA {schema_table.split('.')[0]}.table_info("
                                           f"{schema_table.split('.', 1)[1]})").fetchall()]


def migrate_from_main(conn: sqlite3.Connection, prefix: str) -> list[str]:
    """Copy account rows out of a pre-split ``main`` database, then drop the tables.

    Runs once: after it there are no account tables left in ``main``, so an
    unqualified name can only ever resolve to the users file.
    """
    if not prefix:
        return []
    moved = []
    for name in TABLES:
        if name not in _main_tables(conn):
            continue
        # Both sides exist (guard against a half-finished earlier run): copy the
        # columns they share, primary keys first, and let existing rows win.
        main_cols = _columns(conn, "main." + name)
        udb_cols = _columns(conn, prefix + name)
        shared = [c for c in udb_cols if c in main_cols]
        if shared:
            cols = ", ".join(shared)
            conn.execute(f"INSERT OR IGNORE INTO {prefix}{name} ({cols}) "
                         f"SELECT {cols} FROM main.{name}")
        conn.execute(f"DROP TABLE main.{name}")
        moved.append(name)
    # Their indexes and triggers went with the tables.
    if moved:
        conn.commit()
    return moved


def ensure(conn: sqlite3.Connection, prefix: str) -> dict:
    """Create the account tables in the users file and migrate a legacy install.

    Returns ``{"path": …, "tables": […], "migrated": […]}`` — handy for a boot log
    line and for tests that assert the split really happened.
    """
    with conn:
        conn.executescript(SCHEMA.format(p=prefix))
        migrated = migrate_from_main(conn, prefix)
    return {
        "path": path_of(conn),
        "tables": list(TABLES),
        "migrated": migrated,
    }


def describe() -> dict:
    """A small, human-readable description for the admin desk."""
    from models import get_db
    conn = get_db()
    path = path_of(conn)
    return {
        "users_db": path,
        "separate_file": bool(path),
        "tables": list(TABLES),
    }
