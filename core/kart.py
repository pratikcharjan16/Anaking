"""
SurveyKart Point System & Collaborative Sharing Engine.

Rules:
  - Every newly registered user receives 100 points in their SurveyKart by default.
  - Each question type in the Studio library has a dedicated point cost:
      Single Select: 10 pts          Multi-Select: 15 pts
      Grid / Matrix: 20 pts          Rating Scale: 20 pts
      Constant Sum: 20 pts           Concept Test: 30 pts
      Heatmap: 30 pts                Delta Question: 30 pts
      Gauge Meter: 10 pts            Walkthrough: 40 pts
      Numeric / Text Entry: 15 pts   Text Grid: 25 pts
      Conjoint: 40 pts
  - Questions added to a project's Kart belong strictly to that single project.
  - Creating another project uses the user's remaining Kart balance (or the user can
    request Admin to allocate more points).
  - Admin controls every user's point limit (can increase or decrease at any time)
    and approves/declines point requests.
  - Sharing a project/survey link with a new or existing user:
      * Prompts unregistered recipients to register first, then attaches the shared
        project/survey link to their account so both users collaborate on a single link.
      * ZERO points are debited from the user with whom a link is shared.
      * Respondent survey links never debit points from anyone filling out a survey.
"""

from __future__ import annotations

import json
import secrets

from models import Study, StudyError, get_db, now, write_lock

DEFAULT_INITIAL_POINTS = 100

# Dedicated point costs for every question type in the library
QUESTION_POINTS: dict[str, int] = {
    "single_select": 10,
    "multi_select": 15,
    "rating_grid": 20,
    "numeric_matrix": 20,
    "rating_scale": 20,
    "sum_to_100": 20,
    "concept_test": 30,
    "heatmap": 30,
    "delta": 30,
    "gauge_meter": 10,
    "walk_through": 40,
    "numeric": 15,
    "open_text": 15,
    "text_grid": 25,
    "choice_task": 40,
    # Additional Studio question/flow types
    "date": 10,
    "rank": 15,
    "slider": 15,
    "semantic_diff": 15,
    "emoji_grid": 15,
    "loop": 25,
    "maxdiff": 35,
    "text_block": 0,
}

# Complete catalog of all 23 platform question types for SurveyKart Builder & Landing Storefront
KART_CATALOG: list[dict] = [
    # Questions (16)
    {"type": "single_select", "name": "Single Select", "points": 10, "icon": "◉", "category": "Questions", "desc": "One answer from a list"},
    {"type": "multi_select", "name": "Multi-Select", "points": 15, "icon": "☑", "category": "Questions", "desc": "Select all options that apply"},
    {"type": "rank", "name": "Rank Order", "points": 15, "icon": "⇅", "category": "Questions", "desc": "Put items in order of preference"},
    {"type": "rating_grid", "name": "Grid / Matrix", "points": 20, "icon": "▦", "category": "Questions", "desc": "Rows × columns matrix evaluation"},
    {"type": "numeric_matrix", "name": "Numeric Matrix", "points": 20, "icon": "▤", "category": "Questions", "desc": "A number for every row × column"},
    {"type": "text_grid", "name": "Text Grid", "points": 25, "icon": "⊞", "category": "Questions", "desc": "Rows × columns open-text & voice boxes"},
    {"type": "rating_scale", "name": "Rating Scale", "points": 20, "icon": "★", "category": "Questions", "desc": "Rate rows on an anchored scale"},
    {"type": "gauge_meter", "name": "Gauge Meter", "points": 10, "icon": "⏱", "category": "Questions", "desc": "Interactive dial speedometer"},
    {"type": "semantic_diff", "name": "NPS / Semantic Scale", "points": 15, "icon": "↔", "category": "Questions", "desc": "Score rows between opposite anchors"},
    {"type": "emoji_grid", "name": "Emoji Reaction", "points": 15, "icon": "☺", "category": "Questions", "desc": "Expressive faces instead of numbers"},
    {"type": "numeric", "name": "Numeric Entry", "points": 15, "icon": "#", "category": "Questions", "desc": "Exact numeric value (%, $, count)"},
    {"type": "open_text", "name": "Text Entry (Open-Ended)", "points": 15, "icon": "¶", "category": "Questions", "desc": "Free-text verbatim + optional voice"},
    {"type": "slider", "name": "Scale Slider", "points": 15, "icon": "⚖", "category": "Questions", "desc": "Drag slider to a numeric value"},
    {"type": "sum_to_100", "name": "Constant Sum", "points": 20, "icon": "Σ", "category": "Questions", "desc": "Allocate 100 points across items"},
    {"type": "date", "name": "Date Picker", "points": 10, "icon": "📅", "category": "Questions", "desc": "Pick a calendar date"},
    {"type": "delta", "name": "Delta Question", "points": 30, "icon": "Δ", "category": "Questions", "desc": "Carry baseline grid forward & measure shift"},
    # Methodologies (5)
    {"type": "concept_test", "name": "Concept Test", "points": 30, "icon": "💡", "category": "Methodologies", "desc": "Present stimulus & rate on rows"},
    {"type": "heatmap", "name": "Heat Map", "points": 30, "icon": "▩", "category": "Methodologies", "desc": "Intensity & click mapping per cell"},
    {"type": "walk_through", "name": "Walkthrough", "points": 40, "icon": "▶", "category": "Methodologies", "desc": "Narrated multi-step product story"},
    {"type": "maxdiff", "name": "MaxDiff", "points": 35, "icon": "⇄", "category": "Methodologies", "desc": "Best / worst trade-off experiment"},
    {"type": "choice_task", "name": "Conjoint", "points": 40, "icon": "⇄", "category": "Methodologies", "desc": "Discrete choice experiment tasks"},
    # Survey Flow & Objects (2)
    {"type": "loop", "name": "Question Loop", "points": 25, "icon": "⟳", "category": "Survey Flow", "desc": "Repeat sub-questions across items"},
    {"type": "text_block", "name": "Text Block", "points": 0, "icon": "≡", "category": "Objects", "desc": "Rich text stimulus step (0 pts)"},
]

TYPE_LABELS: dict[str, str] = {item["type"]: item["name"] for item in KART_CATALOG}

SCHEMA = """
CREATE TABLE IF NOT EXISTS point_transactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    delta INTEGER NOT NULL,
    balance_after INTEGER NOT NULL,
    reason TEXT NOT NULL DEFAULT '',
    actor TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_pt_tx_user ON point_transactions(user_id, id DESC);

CREATE TABLE IF NOT EXISTS point_requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    requested_points INTEGER NOT NULL,
    reason TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'pending',
    reviewed_by TEXT NOT NULL DEFAULT '',
    reviewed_at TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_pt_req_status ON point_requests(status, id DESC);

CREATE TABLE IF NOT EXISTS study_shares (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    study_slug TEXT NOT NULL,
    shared_by INTEGER NOT NULL DEFAULT 0,
    shared_with_user_id INTEGER NOT NULL DEFAULT 0,
    shared_with_email TEXT NOT NULL DEFAULT '',
    permission TEXT NOT NULL DEFAULT 'collaborate',
    token TEXT UNIQUE NOT NULL,
    created_at TEXT NOT NULL,
    accepted_at TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS ix_study_shares_slug ON study_shares(study_slug);
CREATE INDEX IF NOT EXISTS ix_study_shares_user ON study_shares(shared_with_user_id);
CREATE INDEX IF NOT EXISTS ix_study_shares_email ON study_shares(shared_with_email);

CREATE TABLE IF NOT EXISTS workspace_teams (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    slug TEXT UNIQUE NOT NULL,
    creator_id INTEGER NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_ws_teams_creator ON workspace_teams(creator_id);

CREATE TABLE IF NOT EXISTS team_members (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    team_id INTEGER NOT NULL,
    invited_by INTEGER NOT NULL DEFAULT 0,
    user_id INTEGER NOT NULL DEFAULT 0,
    email TEXT NOT NULL DEFAULT '',
    role TEXT NOT NULL DEFAULT 'collaborator',
    status TEXT NOT NULL DEFAULT 'pending',
    token TEXT UNIQUE NOT NULL,
    created_at TEXT NOT NULL,
    accepted_at TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS ix_team_members_team ON team_members(team_id);
CREATE INDEX IF NOT EXISTS ix_team_members_user ON team_members(user_id);
CREATE INDEX IF NOT EXISTS ix_team_members_email ON team_members(email);

CREATE TABLE IF NOT EXISTS team_projects (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    team_id INTEGER NOT NULL,
    study_slug TEXT NOT NULL,
    added_by INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    UNIQUE(team_id, study_slug)
);
CREATE INDEX IF NOT EXISTS ix_team_projects_team ON team_projects(team_id);
CREATE INDEX IF NOT EXISTS ix_team_projects_slug ON team_projects(study_slug);

CREATE TABLE IF NOT EXISTS workspace_changelogs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    team_id INTEGER NOT NULL DEFAULT 0,
    study_slug TEXT NOT NULL DEFAULT '',
    actor_id INTEGER NOT NULL DEFAULT 0,
    actor_name TEXT NOT NULL DEFAULT '',
    actor_email TEXT NOT NULL DEFAULT '',
    action_type TEXT NOT NULL DEFAULT 'edit',
    short_summary TEXT NOT NULL,
    created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_ws_changelogs_slug ON workspace_changelogs(study_slug, id DESC);
CREATE INDEX IF NOT EXISTS ix_ws_changelogs_team ON workspace_changelogs(team_id, id DESC);
"""


def question_points(q_or_type) -> int:
    qtype = q_or_type.get("type") if isinstance(q_or_type, dict) else str(q_or_type or "")
    return int(QUESTION_POINTS.get(str(qtype or "").strip(), 15))


def study_points(cfg: dict | None) -> int:
    """Total Kart points consumed by a study's questions.
    Translation child studies mirror their parent and consume 0 extra points."""
    if not cfg or not isinstance(cfg, dict):
        return 0
    if cfg.get("parent"):
        return 0
    return sum(question_points(q) for q in (cfg.get("questions") or []) if isinstance(q, dict))


def study_points_breakdown(cfg: dict | None) -> list[dict]:
    """Grouped point receipt per question type in a single project's Kart."""
    if not cfg or not isinstance(cfg, dict) or cfg.get("parent"):
        return []
    counts: dict[str, int] = {}
    order: list[str] = []
    for q in (cfg.get("questions") or []):
        if not isinstance(q, dict):
            continue
        t = str(q.get("type") or "open_text")
        if t not in counts:
            counts[t] = 0
            order.append(t)
        counts[t] += 1
    out = []
    for t in order:
        unit = question_points(t)
        cnt = counts[t]
        out.append({
            "type": t,
            "name": TYPE_LABELS.get(t, t),
            "count": cnt,
            "unit_points": unit,
            "subtotal": cnt * unit,
        })
    return out


def user_points_usage(user_id: int, exclude_slug: str = "") -> int:
    """Sum of Kart points across all projects owned by ``user_id``."""
    if not user_id or int(user_id) <= 0:
        return 0
    rows = get_db().execute(
        "SELECT slug, cfg FROM studies WHERE owner_id=?", (int(user_id),)
    ).fetchall()
    total = 0
    for r in rows:
        if exclude_slug and r["slug"] == exclude_slug:
            continue
        try:
            cfg = json.loads(r["cfg"]) if r["cfg"] else {}
        except (ValueError, TypeError):
            cfg = {}
        total += study_points(cfg)
    return total


def log_point_transaction(user_id: int, delta: int, limit_after: int, reason: str, actor: str = "system") -> None:
    db = get_db()
    with write_lock, db:
        db.execute(
            "INSERT INTO point_transactions (user_id, delta, balance_after, reason, actor, created_at) "
            "VALUES (?,?,?,?,?,?)",
            (int(user_id), int(delta), int(limit_after), str(reason or "")[:300], str(actor or "")[:120], now()),
        )


def enforce_kart_budget(owner_id: int | None, slug: str, new_cfg: dict, actor_is_admin: bool = False) -> dict:
    """Validate that saving ``new_cfg`` for ``slug`` fits within ``owner_id``'s Kart allocation.

    - Admin accounts (or admin actors editing any study) are never restricted.
    - Anonymous/unowned studies (owner_id == 0, e.g. automated tests with auth off) are unrestricted.
    - Collaborators editing a shared project never have their own points debited; ``owner_id``
      is the project owner's ID.
    - Reducing or keeping the same point total on an existing project is always allowed.
    """
    uid = int(owner_id or 0)
    new_pts = study_points(new_cfg)
    if uid <= 0 or actor_is_admin:
        return {"ok": True, "study_points": new_pts}
    row = get_db().execute("SELECT id, role, points_limit FROM users WHERE id=?", (uid,)).fetchone()
    if not row or row["role"] == "admin":
        return {"ok": True, "study_points": new_pts}

    limit = int(row["points_limit"] if row["points_limit"] is not None else DEFAULT_INITIAL_POINTS)
    existing = Study.get(slug) if slug else None
    old_pts = study_points(existing.cfg) if existing else 0
    if existing and new_pts <= old_pts:
        return {"ok": True, "study_points": new_pts, "points_limit": limit}

    other_used = user_points_usage(uid, exclude_slug=slug or "")
    total_after = other_used + new_pts
    if total_after > limit:
        available_for_study = max(0, limit - other_used)
        shortfall = total_after - limit
        raise StudyError(
            f"Not enough SurveyKart points: this project Kart needs {new_pts} pts "
            f"(only {available_for_study} pts available out of {limit} allocated; {shortfall} pts short). "
            f"Remove questions from your Kart or request Admin to allocate more points.",
            402,
        )
    return {
        "ok": True,
        "study_points": new_pts,
        "points_limit": limit,
        "points_used": total_after,
        "points_balance": max(0, limit - total_after),
    }


def user_kart_summary(user_id: int) -> dict:
    """Complete Kart wallet, per-project Kart breakdown, shared links & point requests for a user."""
    db = get_db()
    u = db.execute("SELECT * FROM users WHERE id=?", (int(user_id),)).fetchone()
    if not u:
        return {
            "authenticated": False,
            "status": "",
            "points_limit": DEFAULT_INITIAL_POINTS,
            "points_used": 0,
            "points_balance": DEFAULT_INITIAL_POINTS,
            "welcome_points_pending": 0,
            "welcome_points_granted": False,
            "owned_projects": [],
            "shared_projects": [],
            "requests": [],
            "transactions": [],
        }
    is_admin = u["role"] == "admin"
    limit = int(u["points_limit"] if u["points_limit"] is not None else DEFAULT_INITIAL_POINTS)
    rows = db.execute(
        "SELECT id, slug, title, status, cfg, updated_at FROM studies WHERE owner_id=? ORDER BY id DESC",
        (int(user_id),),
    ).fetchall()
    owned_projects = []
    used = 0
    for r in rows:
        try:
            cfg = json.loads(r["cfg"]) if r["cfg"] else {}
        except (ValueError, TypeError):
            cfg = {}
        if cfg.get("parent"):
            continue
        pts = study_points(cfg)
        used += pts
        owned_projects.append({
            "slug": r["slug"],
            "title": r["title"],
            "status": r["status"],
            "updated_at": r["updated_at"],
            "questions_count": len(cfg.get("questions") or []),
            "points_used": pts,
            "breakdown": study_points_breakdown(cfg),
        })

    shared_projects = shared_studies_for_user(int(user_id), u["email"])
    reqs = [
        dict(r) for r in db.execute(
            "SELECT * FROM point_requests WHERE user_id=? ORDER BY id DESC LIMIT 20",
            (int(user_id),),
        ).fetchall()
    ]
    txs = [
        dict(r) for r in db.execute(
            "SELECT * FROM point_transactions WHERE user_id=? ORDER BY id DESC LIMIT 25",
            (int(user_id),),
        ).fetchall()
    ]
    # Welcome-allocation state (one-time 100 pts, added on admin approval for
    # Google accounts). Reused from core.accounts to keep one definition.
    from core.accounts import DEFAULT_POINTS as _WELCOME_PTS, has_welcome_allocation
    welcomed = has_welcome_allocation(int(u["id"]))
    return {
        "authenticated": True,
        "user_id": int(u["id"]),
        "email": u["email"],
        "name": u["name"],
        "role": u["role"],
        "status": u["status"],
        "is_admin": is_admin,
        "welcome_points_granted": welcomed,
        "welcome_points_pending": (
            _WELCOME_PTS if (u["status"] == "pending" and not is_admin and not welcomed) else 0
        ),
        "points_limit": limit,
        "points_used": used,
        "points_balance": 999999 if is_admin else max(0, limit - used),
        "raw_balance": limit - used,
        "owned_projects": owned_projects,
        "shared_projects": shared_projects,
        "requests": reqs,
        "transactions": txs,
    }


# ------------------------------------------------------------------ Point Requests
def create_point_request(user_id: int, requested_points: int, reason: str = "") -> dict:
    pts = int(requested_points or 0)
    if pts < 5 or pts > 10000:
        raise StudyError("Request between 5 and 10,000 points.", 400)
    db, ts = get_db(), now()
    with write_lock, db:
        cur = db.execute(
            "INSERT INTO point_requests (user_id, requested_points, reason, status, created_at) "
            "VALUES (?,?,?,'pending',?)",
            (int(user_id), pts, str(reason or "").strip()[:500], ts),
        )
        rid = cur.lastrowid
    row = db.execute("SELECT * FROM point_requests WHERE id=?", (rid,)).fetchone()
    return dict(row)


def list_point_requests(status: str = "") -> list[dict]:
    db = get_db()
    sql = (
        "SELECT pr.*, u.email AS user_email, u.name AS user_name, u.points_limit "
        "FROM point_requests pr JOIN users u ON u.id = pr.user_id "
    )
    params: tuple = ()
    if status:
        sql += "WHERE pr.status=? "
        params = (status,)
    sql += "ORDER BY CASE pr.status WHEN 'pending' THEN 0 ELSE 1 END, pr.id DESC LIMIT 100"
    return [dict(r) for r in db.execute(sql, params).fetchall()]


def decide_point_request(request_id: int, decision: str, actor_email: str = "admin",
                         override_points: int | None = None) -> dict:
    if decision not in ("approve", "reject"):
        raise StudyError("decision must be approve or reject", 400)
    db, ts = get_db(), now()
    req = db.execute("SELECT * FROM point_requests WHERE id=?", (int(request_id),)).fetchone()
    if not req:
        raise StudyError("Point request not found", 404)
    if req["status"] != "pending":
        raise StudyError("This point request has already been processed.", 400)
    grant = int(override_points) if override_points is not None else int(req["requested_points"])
    new_status = "approved" if decision == "approve" else "rejected"
    with write_lock, db:
        db.execute(
            "UPDATE point_requests SET status=?, requested_points=?, reviewed_by=?, reviewed_at=? WHERE id=?",
            (new_status, grant, str(actor_email or "admin"), ts, int(request_id)),
        )
        if decision == "approve":
            u = db.execute("SELECT points_limit FROM users WHERE id=?", (req["user_id"],)).fetchone()
            cur_limit = int(u["points_limit"] if u and u["points_limit"] is not None else DEFAULT_INITIAL_POINTS)
            new_limit = cur_limit + max(0, grant)
            db.execute("UPDATE users SET points_limit=? WHERE id=?", (new_limit, req["user_id"]))
            db.execute(
                "INSERT INTO point_transactions (user_id, delta, balance_after, reason, actor, created_at) "
                "VALUES (?,?,?,?,?,?)",
                (req["user_id"], max(0, grant), new_limit,
                 f"Approved point request #{request_id}", str(actor_email or "admin"), ts),
            )
    out = dict(db.execute("SELECT * FROM point_requests WHERE id=?", (int(request_id),)).fetchone())
    u_after = db.execute("SELECT points_limit FROM users WHERE id=?", (req["user_id"],)).fetchone()
    out["new_points_limit"] = int(u_after["points_limit"] if u_after and u_after["points_limit"] is not None else DEFAULT_INITIAL_POINTS)
    return out


# ------------------------------------------------------------------ Collaborative & Respondent Sharing + Teams + Change Log
import os
import re as _re
from flask import current_app, g


def _current_actor_info(actor_user: dict | None = None) -> tuple[int, str, str]:
    """Return (actor_id, actor_name, actor_email) for the signed-in user or staff."""
    u = actor_user or getattr(g, "user", None)
    if u and isinstance(u, dict):
        uid = int(u.get("id") or 0)
        email = str(u.get("email") or "").strip()
        name = str(u.get("name") or u.get("username") or email or "User").strip()
        return uid, name, email
    st = getattr(g, "staff", None)
    if st and isinstance(st, dict):
        uname = str(st.get("username") or "staff").strip()
        return 0, uname, uname
    return 0, "Workspace User", "local-preview"


def get_changelog_file_path() -> str:
    """Return the path to the backend short change-log file (`workspace_changes.log`)."""
    try:
        db_path = current_app.config.get("DB_PATH") or ""
        if db_path:
            folder = os.path.dirname(os.path.abspath(db_path))
            os.makedirs(folder, exist_ok=True)
            return os.path.join(folder, "workspace_changes.log")
    except RuntimeError:
        pass
    fallback_dir = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "data")
    os.makedirs(fallback_dir, exist_ok=True)
    return os.path.join(fallback_dir, "workspace_changes.log")


def record_workspace_change(study_slug: str = "", action_type: str = "edit",
                            short_summary: str = "", team_id: int = 0,
                            actor_user: dict | None = None) -> dict:
    """Record who made what change to a project, team, or link in very short form
    both in SQLite (`workspace_changelogs`) and in the backend log file (`workspace_changes.log`)."""
    db, ts = get_db(), now()
    actor_id, actor_name, actor_email = _current_actor_info(actor_user)
    slug = str(study_slug or "").strip()
    tid = int(team_id or 0)
    if not tid and slug:
        t_row = db.execute(
            "SELECT team_id FROM team_projects WHERE study_slug=? ORDER BY id DESC LIMIT 1",
            (slug,),
        ).fetchone()
        if t_row:
            tid = int(t_row["team_id"])
    team_name = ""
    if tid:
        tr = db.execute("SELECT name FROM workspace_teams WHERE id=?", (tid,)).fetchone()
        if tr:
            team_name = tr["name"]

    summary = str(short_summary or action_type).strip()[:240]
    with write_lock, db:
        cur = db.execute(
            "INSERT INTO workspace_changelogs (team_id, study_slug, actor_id, actor_name, "
            "actor_email, action_type, short_summary, created_at) VALUES (?,?,?,?,?,?,?,?)",
            (tid, slug, actor_id, actor_name[:120], actor_email[:160],
             str(action_type or "edit")[:40], summary, ts),
        )
        cid = cur.lastrowid

    # Append a compact, human-readable line to the backend log file
    actor_display = f"{actor_name} <{actor_email}>" if actor_email and actor_email != actor_name else actor_name
    scope_parts = []
    if slug:
        scope_parts.append(f"project:{slug}")
    if team_name:
        scope_parts.append(f"team:{team_name}")
    scope_tag = " | ".join(scope_parts) if scope_parts else "workspace"
    line = f"[{ts}] {actor_display} | {scope_tag} | {action_type.upper()} | {summary}\n"
    try:
        log_path = get_changelog_file_path()
        with open(log_path, "a", encoding="utf-8") as fh:
            fh.write(line)
        # Also mirror to repo data/workspace_changes.log when not running isolated unit tests
        try:
            is_testing = bool(current_app.config.get("TESTING"))
        except RuntimeError:
            is_testing = False
        if not is_testing:
            repo_data_dir = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "data")
            os.makedirs(repo_data_dir, exist_ok=True)
            repo_log = os.path.join(repo_data_dir, "workspace_changes.log")
            if os.path.abspath(repo_log) != os.path.abspath(log_path):
                with open(repo_log, "a", encoding="utf-8") as rfh:
                    rfh.write(line)
    except OSError:
        pass

    return {
        "id": cid,
        "team_id": tid,
        "team_name": team_name,
        "study_slug": slug,
        "actor_id": actor_id,
        "actor_name": actor_name,
        "actor_email": actor_email,
        "action_type": action_type,
        "short_summary": summary,
        "created_at": ts,
    }


def summarize_cfg_changes(old_study: Study | None, new_title: str, new_cfg: dict) -> str:
    """Produce a very short human-readable summary of what changed in a project save."""
    new_qs = [q for q in (new_cfg.get("questions") or []) if isinstance(q, dict)]
    if old_study is None:
        return f"Created project '{new_title}' ({len(new_qs)} questions, {study_points(new_cfg)} pts)"

    changes: list[str] = []
    if old_study.title != new_title:
        changes.append(f"Renamed to '{new_title}'")

    old_cfg = old_study.cfg or {}
    old_qs = [q for q in (old_cfg.get("questions") or []) if isinstance(q, dict)]
    old_map = {str(q.get("id")): q for q in old_qs if q.get("id")}
    new_map = {str(q.get("id")): q for q in new_qs if q.get("id")}

    added = [f"{qid} ({new_map[qid].get('type','q')})" for qid in new_map if qid not in old_map]
    removed = [qid for qid in old_map if qid not in new_map]
    edited = []
    for qid, nq in new_map.items():
        if qid in old_map:
            oq = old_map[qid]
            if json.dumps(oq, sort_keys=True) != json.dumps(nq, sort_keys=True):
                edited.append(qid)

    if added:
        changes.append("Added " + ", ".join(added[:3]) + (f" +{len(added)-3} more" if len(added) > 3 else ""))
    if removed:
        changes.append("Removed " + ", ".join(removed[:3]) + (f" +{len(removed)-3} more" if len(removed) > 3 else ""))
    if edited:
        changes.append("Edited " + ", ".join(edited[:4]) + (f" +{len(edited)-4} more" if len(edited) > 4 else ""))

    for k, label in (("research_brief", "brief"), ("privacy_notice", "privacy notice"),
                     ("consent_statement", "consent"), ("quota_target", "quota target"),
                     ("translations", "translations"), ("walkthrough", "walkthrough"),
                     ("conjoint", "conjoint")):
        if old_cfg.get(k) != new_cfg.get(k):
            changes.append(f"Updated {label}")

    if not changes:
        return f"Saved project '{new_title}' ({len(new_qs)} questions)"
    return "; ".join(changes)[:220]


def list_workspace_changelogs(study_slug: str = "", team_id: int = 0,
                              user_id: int = 0, user_email: str = "",
                              limit: int = 40) -> list[dict]:
    """Return short change-log entries for a study, a team, or all studies/teams accessible to a user."""
    db = get_db()
    if study_slug:
        rows = db.execute(
            "SELECT wc.*, wt.name AS team_name FROM workspace_changelogs wc "
            "LEFT JOIN workspace_teams wt ON wt.id=wc.team_id "
            "WHERE wc.study_slug=? ORDER BY wc.id DESC LIMIT ?",
            (study_slug, int(limit)),
        ).fetchall()
        return [dict(r) for r in rows]
    if team_id:
        rows = db.execute(
            "SELECT wc.*, wt.name AS team_name FROM workspace_changelogs wc "
            "LEFT JOIN workspace_teams wt ON wt.id=wc.team_id "
            "WHERE wc.team_id=? ORDER BY wc.id DESC LIMIT ?",
            (int(team_id), int(limit)),
        ).fetchall()
        return [dict(r) for r in rows]
    rows = db.execute(
        "SELECT wc.*, wt.name AS team_name FROM workspace_changelogs wc "
        "LEFT JOIN workspace_teams wt ON wt.id=wc.team_id "
        "ORDER BY wc.id DESC LIMIT ?",
        (int(limit),),
    ).fetchall()
    return [dict(r) for r in rows]


def read_changelog_file_text(study_slug: str = "", team_id: int = 0, limit: int = 100) -> str:
    """Format the backend change-log lines as plain text for direct file viewing/downloading."""
    entries = list_workspace_changelogs(study_slug=study_slug, team_id=team_id, limit=limit)
    header = (
        "# SURVEYKART SHARED WORKSPACE — SHORT BACKEND CHANGE LOG (workspace_changes.log)\n"
        "# Format: [TIMESTAMP] ACTOR_NAME <EMAIL> | PROJECT / TEAM | ACTION | SHORT_CHANGE_SUMMARY\n"
        "# Points Rule: Only the Team Creator / Collaboration Inviter is debited Kart points (0 pts debited from collaborators).\n"
        + ("-" * 96) + "\n"
    )
    if not entries:
        return header + "(No changes recorded yet.)\n"
    lines = []
    for e in entries:
        actor_disp = f"{e['actor_name']} <{e['actor_email']}>" if e.get("actor_email") and e["actor_email"] != e["actor_name"] else (e.get("actor_name") or "User")
        scope = []
        if e.get("study_slug"):
            scope.append(f"project:{e['study_slug']}")
        if e.get("team_name"):
            scope.append(f"team:{e['team_name']}")
        scope_str = " | ".join(scope) if scope else "workspace"
        lines.append(f"[{e['created_at']}] {actor_disp} | {scope_str} | {str(e.get('action_type','edit')).upper()} | {e['short_summary']}")
    return header + "\n".join(lines) + "\n"


def _slugify_team(name: str) -> str:
    base = _re.sub(r"[^a-z0-9\-]+", "-", (name or "team").lower()).strip("-")[:28] or "team"
    return f"{base}-{secrets.token_hex(3)}"


def ensure_team_for_study(study_slug: str, creator_id: int, team_name: str = "") -> dict | None:
    """Ensure a project being shared for collaboration belongs to a Workspace Team."""
    st = Study.get(study_slug)
    if not st:
        return None
    db, ts = get_db(), now()
    existing_tp = db.execute(
        "SELECT wt.* FROM team_projects tp JOIN workspace_teams wt ON wt.id=tp.team_id "
        "WHERE tp.study_slug=? ORDER BY tp.id DESC LIMIT 1",
        (st.slug,),
    ).fetchone()
    if existing_tp:
        return dict(existing_tp)

    eff_creator = int(st.owner_id or creator_id or 0)
    tname = (team_name or f"{st.title} Team").strip()[:100]
    tslug = _slugify_team(tname)
    with write_lock, db:
        cur = db.execute(
            "INSERT INTO workspace_teams (name, slug, creator_id, description, created_at, updated_at) "
            "VALUES (?,?,?,?,?,?)",
            (tname, tslug, eff_creator, f"Shared workspace team for {st.title}", ts, ts),
        )
        tid = cur.lastrowid
        db.execute(
            "INSERT OR IGNORE INTO team_projects (team_id, study_slug, added_by, created_at) VALUES (?,?,?,?)",
            (tid, st.slug, eff_creator, ts),
        )
    return dict(db.execute("SELECT * FROM workspace_teams WHERE id=?", (tid,)).fetchone())


def create_team_and_invite(creator_user: dict | None, team_name: str = "",
                           invite_email: str = "", study_slug: str = "",
                           description: str = "", team_id: int = 0) -> dict:
    """Create a Team (or use an existing team) on the Workspace and optionally invite a teammate
    by Mail ID / Google ID (`invite_email`) and/or attach a project (`study_slug`).
    Only the Team Creator (`creator_id`) ever has Kart points debited."""
    db, ts = get_db(), now()
    uid, uname, uemail = _current_actor_info(creator_user)
    clean_email = str(invite_email or "").strip().lower()
    if clean_email and "@" not in clean_email:
        raise StudyError("Enter a valid teammate Mail ID / Google ID (e.g. teammate@gmail.com).", 400)

    team_row = None
    if team_id:
        team_row = db.execute("SELECT * FROM workspace_teams WHERE id=?", (int(team_id),)).fetchone()
        if not team_row:
            raise StudyError("Team not found.", 404)
    elif study_slug and not team_name:
        team_row = ensure_team_for_study(study_slug, uid)
    else:
        tname = (team_name or f"{uname}'s Research Team").strip()[:100]
        tslug = _slugify_team(tname)
        with write_lock, db:
            cur = db.execute(
                "INSERT INTO workspace_teams (name, slug, creator_id, description, created_at, updated_at) "
                "VALUES (?,?,?,?,?,?)",
                (tname, tslug, uid, str(description or "Collaborative research team space")[:300], ts, ts),
            )
            tid = cur.lastrowid
        team_row = db.execute("SELECT * FROM workspace_teams WHERE id=?", (tid,)).fetchone()
        record_workspace_change(
            study_slug=study_slug,
            action_type="team_create",
            short_summary=f"Created team '{tname}' (points sponsored by {uname})",
            team_id=tid,
            actor_user=creator_user,
        )

    team = dict(team_row)
    tid = int(team["id"])

    # If a study_slug was provided, attach it to this team and bind existing accepted members
    if study_slug:
        st = Study.get(study_slug)
        if not st:
            raise StudyError("Project not found.", 404)
        with write_lock, db:
            db.execute(
                "INSERT OR IGNORE INTO team_projects (team_id, study_slug, added_by, created_at) VALUES (?,?,?,?)",
                (tid, st.slug, uid, ts),
            )
            # Grant collaboration share rows to all already-accepted team members
            accepted_members = db.execute(
                "SELECT * FROM team_members WHERE team_id=? AND status='accepted'", (tid,)
            ).fetchall()
            for m in accepted_members:
                existing_sh = db.execute(
                    "SELECT id FROM study_shares WHERE study_slug=? AND permission='collaborate' "
                    "AND (shared_with_user_id=? OR (shared_with_email != '' AND shared_with_email=?))",
                    (st.slug, m["user_id"], m["email"]),
                ).fetchone()
                if not existing_sh:
                    db.execute(
                        "INSERT INTO study_shares (study_slug, shared_by, shared_with_user_id, shared_with_email, "
                        "permission, token, created_at, accepted_at) VALUES (?,?,?,?,'collaborate',?,?,?)",
                        (st.slug, team["creator_id"], m["user_id"], m["email"],
                         secrets.token_urlsafe(18), ts, ts),
                    )
        record_workspace_change(
            study_slug=st.slug,
            action_type="team_project",
            short_summary=f"Added project '{st.title}' to shared team '{team['name']}'",
            team_id=tid,
            actor_user=creator_user,
        )

    invite_info = None
    if clean_email:
        # Check if an invite already exists in this team for clean_email
        existing_mem = db.execute(
            "SELECT * FROM team_members WHERE team_id=? AND email=?",
            (tid, clean_email),
        ).fetchone()
        if existing_mem:
            invite_info = dict(existing_mem)
            token = invite_info["token"]
        else:
            token = secrets.token_urlsafe(18)
            with write_lock, db:
                cur = db.execute(
                    "INSERT INTO team_members (team_id, invited_by, user_id, email, role, status, token, created_at, accepted_at) "
                    "VALUES (?,?,0,?,'collaborator','pending',?,?,'')",
                    (tid, uid, clean_email, token, ts),
                )
                mid = cur.lastrowid
            invite_info = dict(db.execute("SELECT * FROM team_members WHERE id=?", (mid,)).fetchone())

        # Also ensure a study_shares row exists for each project in the team (so /share/<token> works for both!)
        t_projects = [
            r["study_slug"] for r in db.execute(
                "SELECT study_slug FROM team_projects WHERE team_id=?", (tid,)
            ).fetchall()
        ]
        primary_slug = study_slug or (t_projects[0] if t_projects else "")
        if primary_slug:
            existing_sh = db.execute(
                "SELECT * FROM study_shares WHERE study_slug=? AND shared_with_email=? AND permission='collaborate'",
                (primary_slug, clean_email),
            ).fetchone()
            if not existing_sh:
                # Use the same token on the primary study_share if unused, else a fresh token
                tok_taken = db.execute("SELECT 1 FROM study_shares WHERE token=?", (token,)).fetchone()
                sh_tok = secrets.token_urlsafe(18) if tok_taken else token
                with write_lock, db:
                    db.execute(
                        "INSERT INTO study_shares (study_slug, shared_by, shared_with_user_id, shared_with_email, "
                        "permission, token, created_at, accepted_at) VALUES (?,?,0,?,'collaborate',?,?,'')",
                        (primary_slug, team["creator_id"] or uid, clean_email, sh_tok, ts),
                    )
        record_workspace_change(
            study_slug=primary_slug,
            action_type="team_invite",
            short_summary=f"Invited {clean_email} to collaborate in team '{team['name']}' (0 pts debited from teammate)",
            team_id=tid,
            actor_user=creator_user,
        )

    return {
        "team": team,
        "invite": invite_info,
        "token": invite_info["token"] if invite_info else "",
    }


def create_share(study_slug: str, shared_by: int, email: str = "",
                 permission: str = "collaborate") -> dict:
    """Create a share link for a study (`collaborate` or `respond`).
    Sharing NEVER debits points from either the sharer or the recipient.
    When `permission == 'collaborate'`, also links the study and invitee to a Workspace Team."""
    st = Study.get(study_slug)
    if not st:
        raise StudyError("unknown study", 404)
    if permission not in ("collaborate", "respond"):
        raise StudyError("permission must be collaborate or respond", 400)
    clean_email = str(email or "").strip().lower()
    db, ts = get_db(), now()

    if permission == "collaborate":
        team = ensure_team_for_study(st.slug, int(st.owner_id or shared_by or 0))
    else:
        team = None

    if clean_email:
        existing = db.execute(
            "SELECT * FROM study_shares WHERE study_slug=? AND shared_with_email=? AND permission=?",
            (st.slug, clean_email, permission),
        ).fetchone()
        if existing:
            return dict(existing)

    token = secrets.token_urlsafe(18)
    with write_lock, db:
        cur = db.execute(
            "INSERT INTO study_shares (study_slug, shared_by, shared_with_user_id, shared_with_email, "
            "permission, token, created_at, accepted_at) VALUES (?,?,0,?,?,?,?, '')",
            (st.slug, int(shared_by or st.owner_id or 0), clean_email, permission, token, ts),
        )
        sid = cur.lastrowid
        if permission == "collaborate" and team and clean_email:
            existing_mem = db.execute(
                "SELECT id FROM team_members WHERE team_id=? AND email=?",
                (team["id"], clean_email),
            ).fetchone()
            if not existing_mem:
                db.execute(
                    "INSERT INTO team_members (team_id, invited_by, user_id, email, role, status, token, created_at, accepted_at) "
                    "VALUES (?,?,0,?,'collaborator','pending',?,?,'')",
                    (team["id"], int(shared_by or st.owner_id or 0), clean_email, token, ts),
                )

    record_workspace_change(
        study_slug=st.slug,
        action_type="share_link",
        short_summary=(
            f"Invited {clean_email or 'collaborator link'} to collaborate on '{st.title}' (0 pts debited)"
            if permission == "collaborate"
            else f"Created respondent survey link for '{st.title}'"
        ),
        team_id=team["id"] if team else 0,
    )
    return dict(db.execute("SELECT * FROM study_shares WHERE id=?", (sid,)).fetchone())


def get_share_by_token(token: str) -> dict | None:
    if not token:
        return None
    tok = str(token).strip()
    db = get_db()
    row = db.execute(
        "SELECT ss.*, s.title AS study_title, s.status AS study_status, "
        "(SELECT COALESCE(NULLIF(name,''), email) FROM users u WHERE u.id=ss.shared_by) AS shared_by_label, "
        "(SELECT email FROM users u WHERE u.id=ss.shared_by) AS shared_by_email "
        "FROM study_shares ss JOIN studies s ON s.slug=ss.study_slug WHERE ss.token=?",
        (tok,),
    ).fetchone()
    if row:
        out = dict(row)
        tm = db.execute(
            "SELECT tm.*, wt.name AS team_name FROM team_members tm "
            "JOIN workspace_teams wt ON wt.id=tm.team_id WHERE tm.token=?",
            (tok,),
        ).fetchone()
        if tm:
            out["team_id"] = tm["team_id"]
            out["team_name"] = tm["team_name"]
        return out

    # Also check if token is a team-level invite token in `team_members`
    tm = db.execute(
        "SELECT tm.*, wt.name AS team_name, wt.creator_id, "
        "(SELECT COALESCE(NULLIF(name,''), email) FROM users u WHERE u.id=tm.invited_by) AS shared_by_label, "
        "(SELECT email FROM users u WHERE u.id=tm.invited_by) AS shared_by_email "
        "FROM team_members tm JOIN workspace_teams wt ON wt.id=tm.team_id WHERE tm.token=?",
        (tok,),
    ).fetchone()
    if not tm:
        return None
    tp = db.execute(
        "SELECT s.slug, s.title, s.status FROM team_projects tp "
        "JOIN studies s ON s.slug=tp.study_slug WHERE tp.team_id=? ORDER BY tp.id DESC LIMIT 1",
        (tm["team_id"],),
    ).fetchone()
    return {
        "id": tm["id"],
        "team_id": tm["team_id"],
        "team_name": tm["team_name"],
        "study_slug": tp["slug"] if tp else "",
        "study_title": tp["title"] if tp else f"Team: {tm['team_name']}",
        "study_status": tp["status"] if tp else "draft",
        "shared_by": tm["invited_by"] or tm["creator_id"],
        "shared_by_label": tm["shared_by_label"] or "Team Creator",
        "shared_by_email": tm["shared_by_email"] or "",
        "shared_with_user_id": tm["user_id"],
        "shared_with_email": tm["email"],
        "permission": "collaborate",
        "token": tm["token"],
        "created_at": tm["created_at"],
        "accepted_at": tm["accepted_at"],
    }


def redeem_share(token: str, user: dict) -> dict | None:
    """Attach a shared collaboration or team link to ``user``'s account upon registration,
    sign-in, or clicking the invite link on their Workspace.
    Forms the team, binds all team projects, and guarantees 0 points are debited from ``user``."""
    share = get_share_by_token(token)
    if not share or not user:
        return None
    uid = int(user["id"])
    uemail = str(user.get("email") or "").strip().lower()
    uname = str(user.get("name") or user.get("username") or uemail).strip()
    db, ts = get_db(), now()
    tok = str(token).strip()

    # 1. If there is a matching team_members invite (by token or by team_id + email), accept it & form the team!
    tm_rows = db.execute(
        "SELECT tm.*, wt.name AS team_name, wt.creator_id FROM team_members tm "
        "JOIN workspace_teams wt ON wt.id=tm.team_id "
        "WHERE tm.token=? OR (tm.email != '' AND tm.email=? AND tm.team_id=?)",
        (tok, uemail, int(share.get("team_id") or 0)),
    ).fetchall()
    formed_team_id = int(share.get("team_id") or 0)
    formed_team_name = share.get("team_name") or ""
    for tm in tm_rows:
        formed_team_id = int(tm["team_id"])
        formed_team_name = tm["team_name"]
        if int(tm["creator_id"] or 0) != uid:
            with write_lock, db:
                db.execute(
                    "UPDATE team_members SET user_id=?, status='accepted', accepted_at=? WHERE id=?",
                    (uid, ts, tm["id"]),
                )
                # Ensure study_shares exist for all projects in this team
                t_slugs = [
                    r["study_slug"] for r in db.execute(
                        "SELECT study_slug FROM team_projects WHERE team_id=?", (formed_team_id,)
                    ).fetchall()
                ]
                for s_slug in t_slugs:
                    ex_sh = db.execute(
                        "SELECT id FROM study_shares WHERE study_slug=? AND permission='collaborate' "
                        "AND (shared_with_user_id=? OR (shared_with_email != '' AND shared_with_email=?))",
                        (s_slug, uid, uemail),
                    ).fetchone()
                    if ex_sh:
                        db.execute(
                            "UPDATE study_shares SET shared_with_user_id=?, accepted_at=? WHERE id=?",
                            (uid, ts, ex_sh["id"]),
                        )
                    else:
                        db.execute(
                            "INSERT INTO study_shares (study_slug, shared_by, shared_with_user_id, shared_with_email, "
                            "permission, token, created_at, accepted_at) VALUES (?,?,?,?,'collaborate',?,?,?)",
                            (s_slug, tm["creator_id"], uid, uemail, secrets.token_urlsafe(18), ts, ts),
                        )

    # 2. If the share is tied to a specific study, also bind `study_shares` and its team
    slug = share.get("study_slug") or ""
    st = Study.get(slug) if slug else None
    if st:
        if st.owner_id == uid:
            return dict(share, already_owner=True, points_debited=0, team_formed=True)

        if share["permission"] == "collaborate":
            team = ensure_team_for_study(st.slug, st.owner_id)
            if team:
                formed_team_id = int(team["id"])
                formed_team_name = team["name"]
                with write_lock, db:
                    ex_mem = db.execute(
                        "SELECT id FROM team_members WHERE team_id=? AND (user_id=? OR (email != '' AND email=?))",
                        (formed_team_id, uid, uemail),
                    ).fetchone()
                    if ex_mem:
                        db.execute(
                            "UPDATE team_members SET user_id=?, email=?, status='accepted', accepted_at=? WHERE id=?",
                            (uid, uemail, ts, ex_mem["id"]),
                        )
                    else:
                        db.execute(
                            "INSERT INTO team_members (team_id, invited_by, user_id, email, role, status, token, created_at, accepted_at) "
                            "VALUES (?,?,?,?,'collaborator','accepted',?,?,?)",
                            (formed_team_id, st.owner_id, uid, uemail, secrets.token_urlsafe(18), ts, ts),
                        )

        existing_user_share = db.execute(
            "SELECT * FROM study_shares WHERE study_slug=? AND shared_with_user_id=? AND permission=?",
            (st.slug, uid, share["permission"]),
        ).fetchone()
        if existing_user_share:
            with write_lock, db:
                db.execute(
                    "UPDATE study_shares SET accepted_at=? WHERE id=? AND accepted_at=''",
                    (ts, existing_user_share["id"]),
                )
        else:
            with write_lock, db:
                if share.get("id") and share["shared_with_user_id"] in (0, uid) and (
                    not share["shared_with_email"] or share["shared_with_email"] == uemail
                ):
                    if not share["shared_with_email"]:
                        new_tok = secrets.token_urlsafe(18)
                        db.execute(
                            "INSERT INTO study_shares (study_slug, shared_by, shared_with_user_id, shared_with_email, "
                            "permission, token, created_at, accepted_at) VALUES (?,?,?,?,?,?,?,?)",
                            (st.slug, share["shared_by"], uid, uemail, share["permission"], new_tok, ts, ts),
                        )
                    else:
                        db.execute(
                            "UPDATE study_shares SET shared_with_user_id=?, accepted_at=? WHERE id=?",
                            (uid, ts, share["id"]),
                        )
                else:
                    new_tok = secrets.token_urlsafe(18)
                    db.execute(
                        "INSERT INTO study_shares (study_slug, shared_by, shared_with_user_id, shared_with_email, "
                        "permission, token, created_at, accepted_at) VALUES (?,?,?,?,?,?,?,?)",
                        (st.slug, share["shared_by"], uid, uemail, share["permission"], new_tok, ts, ts),
                    )

    record_workspace_change(
        study_slug=slug,
        action_type="team_join",
        short_summary=(
            f"{uname} ({uemail}) accepted collaboration link — Team '{formed_team_name or 'Shared Workspace'}' formed (0 pts debited)"
        ),
        team_id=formed_team_id,
        actor_user=user,
    )
    return dict(
        share,
        shared_with_user_id=uid,
        shared_with_email=uemail,
        accepted_at=ts,
        team_id=formed_team_id,
        team_name=formed_team_name,
        team_formed=True,
        points_debited=0,
    )


def can_collaborate(user_id: int, slug: str, user_email: str = "") -> bool:
    if not user_id or not slug:
        return False
    db = get_db()
    uemail = str(user_email or "").strip().lower()
    if not uemail:
        r = db.execute("SELECT email FROM users WHERE id=?", (int(user_id),)).fetchone()
        uemail = (r["email"] if r else "").lower()
    row = db.execute(
        "SELECT 1 FROM study_shares WHERE study_slug=? AND permission='collaborate' "
        "AND (shared_with_user_id=? OR (shared_with_email != '' AND shared_with_email=? AND accepted_at != '')) LIMIT 1",
        (slug, int(user_id), uemail),
    ).fetchone()
    if row:
        return True
    # Also check if the user is the creator or an accepted member of a Team that owns/shares this study
    t_row = db.execute(
        "SELECT 1 FROM team_projects tp "
        "JOIN workspace_teams wt ON wt.id=tp.team_id "
        "LEFT JOIN team_members tm ON tm.team_id=wt.id AND tm.status='accepted' "
        "WHERE tp.study_slug=? AND (wt.creator_id=? OR tm.user_id=? OR (tm.email != '' AND tm.email=?)) LIMIT 1",
        (slug, int(user_id), int(user_id), uemail),
    ).fetchone()
    return bool(t_row)


def shared_studies_for_user(user_id: int, user_email: str = "") -> list[dict]:
    if not user_id:
        return []
    db = get_db()
    uemail = str(user_email or "").strip().lower()
    if not uemail:
        r = db.execute("SELECT email FROM users WHERE id=?", (int(user_id),)).fetchone()
        uemail = (r["email"] if r else "").lower()
    rows = db.execute(
        "SELECT ss.*, s.id AS sid, s.title, s.status, s.updated_at, s.cfg, s.owner_id, "
        "(SELECT email FROM users u WHERE u.id=s.owner_id) AS owner_email, "
        "(SELECT name FROM users u WHERE u.id=s.owner_id) AS owner_name, "
        "(SELECT COUNT(*) FROM respondents r WHERE r.study_id=s.id) AS started, "
        "(SELECT COUNT(*) FROM respondents r WHERE r.study_id=s.id AND r.status='complete') AS complete "
        "FROM study_shares ss JOIN studies s ON s.slug=ss.study_slug "
        "WHERE s.owner_id != ? AND (ss.shared_with_user_id=? OR (ss.shared_with_email != '' AND ss.shared_with_email=?)) "
        "ORDER BY ss.id DESC",
        (int(user_id), int(user_id), uemail),
    ).fetchall()
    seen: set[tuple[str, str]] = set()
    out = []
    for r in rows:
        key = (r["study_slug"], r["permission"])
        if key in seen:
            continue
        seen.add(key)
        out.append({
            "share_id": r["id"],
            "slug": r["study_slug"],
            "study_slug": r["study_slug"],
            "study_id": f"STU-{r['sid']:06d}",
            "title": r["title"],
            "study_title": r["title"],
            "status": r["status"],
            "updated_at": r["updated_at"],
            "started": r["started"] or 0,
            "complete": r["complete"] or 0,
            "owner_id": r["owner_id"] or 0,
            "owner_email": r["owner_email"] or "",
            "owner_name": r["owner_name"] or "",
            "shared_by_email": r["owner_email"] or "",
            "permission": r["permission"],
            "token": r["token"],
            "share_url": f"/share/{r['token']}",
            "is_accepted": bool(r["accepted_at"] or r["shared_with_user_id"] == int(user_id)),
            "points_debited": 0,
            "survey_link": f"/survey/{r['study_slug']}",
            "test_link": f"/survey/{r['study_slug']}/test",
            "studio_link": f"/studio/#{r['study_slug']}" if r["permission"] == "collaborate" else "",
            "workspace_link": f"/workspace/#{r['study_slug']}" if r["permission"] == "collaborate" else "",
            "created_at": r["created_at"],
            "accepted_at": r["accepted_at"],
        })
    return out


def study_collaborators(slug: str) -> list[dict]:
    """Return all collaborators (invited & accepted) for ``slug`` with their Account Name and email."""
    db = get_db()
    rows = db.execute(
        "SELECT ss.*, "
        "COALESCE(u1.name, u2.name, '') AS account_name, "
        "COALESCE(u1.username, u2.username, '') AS username, "
        "COALESCE(u1.email, u2.email, ss.shared_with_email) AS account_email "
        "FROM study_shares ss "
        "LEFT JOIN users u1 ON u1.id=ss.shared_with_user_id AND ss.shared_with_user_id > 0 "
        "LEFT JOIN users u2 ON ss.shared_with_email != '' AND u2.email=ss.shared_with_email "
        "WHERE ss.study_slug=? AND ss.permission='collaborate' ORDER BY ss.id DESC",
        (slug,),
    ).fetchall()
    out = []
    seen = set()
    for r in rows:
        email_key = (r["account_email"] or r["token"]).lower()
        if email_key in seen:
            continue
        seen.add(email_key)
        is_active = bool(r["accepted_at"] or r["shared_with_user_id"] > 0)
        out.append({
            "share_id": r["id"],
            "user_id": r["shared_with_user_id"],
            "name": r["account_name"] or (r["account_email"].split("@")[0] if r["account_email"] else "Invited Collaborator"),
            "account_name": r["account_name"] or "",
            "username": r["username"] or "",
            "email": r["account_email"] or "",
            "status": "accepted" if is_active else "pending",
            "token": r["token"],
            "share_url": f"/share/{r['token']}",
            "accepted_at": r["accepted_at"] or "",
            "created_at": r["created_at"],
            "points_debited": 0,
        })
    return out


def list_teams_and_collaboration(user_id: int, user_email: str = "") -> dict:
    """Return complete Team & Collaboration state for a logged-in user's Workspace:
    - `teams`: teams created by or joined by the user (with full member roster, account names,
      shared projects, and points sponsor info)
    - `incoming_invites`: pending team/project collaboration requests addressed to `user_email`
    - `changelogs`: recent short change-log entries across the user's shared workspace
    """
    if not user_id:
        return {"teams": [], "incoming_invites": [], "changelogs": []}
    db = get_db()
    uid = int(user_id)
    uemail = str(user_email or "").strip().lower()
    if not uemail:
        ur = db.execute("SELECT email FROM users WHERE id=?", (uid,)).fetchone()
        uemail = (ur["email"] if ur else "").lower()

    # 1. Incoming pending invites (from `team_members` and `study_shares`)
    incoming_map: dict[str, dict] = {}
    tm_pending = db.execute(
        "SELECT tm.*, wt.name AS team_name, wt.creator_id, "
        "(SELECT COALESCE(NULLIF(name,''), email) FROM users u WHERE u.id=wt.creator_id) AS creator_name, "
        "(SELECT email FROM users u WHERE u.id=wt.creator_id) AS creator_email "
        "FROM team_members tm JOIN workspace_teams wt ON wt.id=tm.team_id "
        "WHERE tm.status='pending' AND wt.creator_id != ? AND (tm.user_id=? OR (tm.email != '' AND tm.email=?)) "
        "ORDER BY tm.id DESC",
        (uid, uid, uemail),
    ).fetchall()
    for tm in tm_pending:
        tp = db.execute(
            "SELECT s.slug, s.title FROM team_projects tp JOIN studies s ON s.slug=tp.study_slug "
            "WHERE tp.team_id=? ORDER BY tp.id DESC LIMIT 1",
            (tm["team_id"],),
        ).fetchone()
        incoming_map[tm["token"]] = {
            "token": tm["token"],
            "share_url": f"/share/{tm['token']}",
            "team_id": tm["team_id"],
            "team_name": tm["team_name"],
            "study_slug": tp["slug"] if tp else "",
            "study_title": tp["title"] if tp else "",
            "inviter_name": tm["creator_name"] or tm["creator_email"] or "SurveyKart User",
            "inviter_email": tm["creator_email"] or "",
            "created_at": tm["created_at"],
            "points_debited": 0,
        }

    sh_pending = db.execute(
        "SELECT ss.*, s.title AS study_title, s.owner_id, "
        "(SELECT COALESCE(NULLIF(name,''), email) FROM users u WHERE u.id=s.owner_id) AS owner_name, "
        "(SELECT email FROM users u WHERE u.id=s.owner_id) AS owner_email "
        "FROM study_shares ss JOIN studies s ON s.slug=ss.study_slug "
        "WHERE ss.permission='collaborate' AND ss.accepted_at='' AND ss.shared_with_user_id=0 "
        "AND s.owner_id != ? AND ss.shared_with_email=? ORDER BY ss.id DESC",
        (uid, uemail),
    ).fetchall()
    for sh in sh_pending:
        if sh["token"] not in incoming_map:
            incoming_map[sh["token"]] = {
                "token": sh["token"],
                "share_url": f"/share/{sh['token']}",
                "team_id": 0,
                "team_name": f"{sh['study_title']} Team",
                "study_slug": sh["study_slug"],
                "study_title": sh["study_title"],
                "inviter_name": sh["owner_name"] or sh["owner_email"] or "SurveyKart User",
                "inviter_email": sh["owner_email"] or "",
                "created_at": sh["created_at"],
                "points_debited": 0,
            }

    # 2. Teams where user is creator or accepted member
    team_rows = db.execute(
        "SELECT DISTINCT wt.*, "
        "(SELECT COALESCE(NULLIF(name,''), email) FROM users u WHERE u.id=wt.creator_id) AS creator_name, "
        "(SELECT email FROM users u WHERE u.id=wt.creator_id) AS creator_email "
        "FROM workspace_teams wt "
        "LEFT JOIN team_members tm ON tm.team_id=wt.id "
        "WHERE wt.creator_id=? OR (tm.status='accepted' AND (tm.user_id=? OR (tm.email != '' AND tm.email=?))) "
        "ORDER BY wt.id DESC",
        (uid, uid, uemail),
    ).fetchall()

    teams_out = []
    for tr in team_rows:
        tid = int(tr["id"])
        mem_rows = db.execute(
            "SELECT tm.*, "
            "COALESCE(u1.name, u2.name, '') AS account_name, "
            "COALESCE(u1.username, u2.username, '') AS username, "
            "COALESCE(u1.email, u2.email, tm.email) AS account_email "
            "FROM team_members tm "
            "LEFT JOIN users u1 ON u1.id=tm.user_id AND tm.user_id > 0 "
            "LEFT JOIN users u2 ON tm.email != '' AND u2.email=tm.email "
            "WHERE tm.team_id=? ORDER BY tm.id ASC",
            (tid,),
        ).fetchall()
        members = [{
            "user_id": tr["creator_id"],
            "name": tr["creator_name"] or tr["creator_email"] or "Team Creator",
            "account_name": tr["creator_name"] or tr["creator_email"] or "Team Creator",
            "email": tr["creator_email"] or "",
            "role": "creator",
            "status": "accepted",
            "is_sponsor": True,
            "points_note": "Points Sponsor (debited for team projects)",
        }]
        accepted_collaborators = 0
        for m in mem_rows:
            if m["status"] == "accepted":
                accepted_collaborators += 1
            members.append({
                "member_id": m["id"],
                "user_id": m["user_id"],
                "name": m["account_name"] or (m["account_email"].split("@")[0] if m["account_email"] else "Invited User"),
                "account_name": m["account_name"] or "",
                "username": m["username"] or "",
                "email": m["account_email"] or m["email"],
                "role": m["role"],
                "status": m["status"],
                "token": m["token"],
                "share_url": f"/share/{m['token']}",
                "accepted_at": m["accepted_at"] or "",
                "is_sponsor": False,
                "points_note": "0 Kart pts debited",
            })

        proj_rows = db.execute(
            "SELECT s.id, s.slug, s.title, s.status, s.updated_at, s.cfg, s.owner_id, "
            "(SELECT COALESCE(NULLIF(name,''), email) FROM users u WHERE u.id=s.owner_id) AS owner_name, "
            "(SELECT email FROM users u WHERE u.id=s.owner_id) AS owner_email "
            "FROM team_projects tp JOIN studies s ON s.slug=tp.study_slug "
            "WHERE tp.team_id=? ORDER BY s.id DESC",
            (tid,),
        ).fetchall()
        t_projects = []
        for pr in proj_rows:
            try:
                pcfg = json.loads(pr["cfg"]) if pr["cfg"] else {}
            except (ValueError, TypeError):
                pcfg = {}
            pts = study_points(pcfg)
            is_owner = int(pr["owner_id"] or 0) == uid
            t_projects.append({
                "slug": pr["slug"],
                "title": pr["title"],
                "status": pr["status"],
                "updated_at": pr["updated_at"],
                "questions_count": len(pcfg.get("questions") or []),
                "points_used": pts,
                "points_debited": pts if is_owner else 0,
                "owner_name": pr["owner_name"] or pr["owner_email"] or "",
                "owner_email": pr["owner_email"] or "",
                "studio_url": f"/studio/#{pr['slug']}",
                "workspace_url": f"/workspace/#{pr['slug']}",
                "survey_url": f"/survey/{pr['slug']}",
                "test_url": f"/survey/{pr['slug']}/test",
            })

        teams_out.append({
            "id": tid,
            "name": tr["name"],
            "slug": tr["slug"],
            "description": tr["description"],
            "creator_id": tr["creator_id"],
            "creator_name": tr["creator_name"] or tr["creator_email"] or "Creator",
            "creator_email": tr["creator_email"] or "",
            "is_creator": int(tr["creator_id"] or 0) == uid,
            "team_formed": accepted_collaborators > 0,
            "accepted_collaborators": accepted_collaborators,
            "members": members,
            "projects": t_projects,
            "created_at": tr["created_at"],
        })

    return {
        "teams": teams_out,
        "incoming_invites": list(incoming_map.values()),
        "changelogs": list_workspace_changelogs(user_id=uid, user_email=uemail, limit=30),
        "changelog_file_url": "/api/workspace/changelog.log",
    }


def shares_for_study(slug: str) -> list[dict]:
    rows = get_db().execute(
        "SELECT ss.*, "
        "COALESCE(u1.email, u2.email, ss.shared_with_email) AS bound_email, "
        "COALESCE(u1.name, u2.name, '') AS bound_name, "
        "CASE WHEN ss.accepted_at != '' OR ss.shared_with_user_id > 0 THEN 1 ELSE 0 END AS claimed_by_user_id "
        "FROM study_shares ss "
        "LEFT JOIN users u1 ON u1.id=ss.shared_with_user_id AND ss.shared_with_user_id > 0 "
        "LEFT JOIN users u2 ON ss.shared_with_email != '' AND u2.email=ss.shared_with_email "
        "WHERE ss.study_slug=? ORDER BY ss.id DESC",
        (slug,),
    ).fetchall()
    return [dict(r) for r in rows]


def revoke_share(share_id: int) -> bool:
    db = get_db()
    row = db.execute("SELECT * FROM study_shares WHERE id=?", (int(share_id),)).fetchone()
    with write_lock, db:
        cur = db.execute("DELETE FROM study_shares WHERE id=?", (int(share_id),))
        if row and row["shared_with_email"]:
            tp = db.execute(
                "SELECT team_id FROM team_projects WHERE study_slug=?", (row["study_slug"],)
            ).fetchone()
            if tp:
                db.execute(
                    "DELETE FROM team_members WHERE team_id=? AND email=?",
                    (tp["team_id"], row["shared_with_email"]),
                )
    if row:
        record_workspace_change(
            study_slug=row["study_slug"],
            action_type="share_revoke",
            short_summary=f"Revoked share link for {row['shared_with_email'] or 'link'}",
        )
    return cur.rowcount > 0

