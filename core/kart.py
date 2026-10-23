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
            "points_limit": DEFAULT_INITIAL_POINTS,
            "points_used": 0,
            "points_balance": DEFAULT_INITIAL_POINTS,
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
    return {
        "authenticated": True,
        "user_id": int(u["id"]),
        "email": u["email"],
        "name": u["name"],
        "role": u["role"],
        "is_admin": is_admin,
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


# ------------------------------------------------------------------ Collaborative & Respondent Sharing
def create_share(study_slug: str, shared_by: int, email: str = "",
                 permission: str = "collaborate") -> dict:
    """Create a share link for a study (`collaborate` or `respond`).
    Sharing NEVER debits points from either the sharer or the recipient."""
    st = Study.get(study_slug)
    if not st:
        raise StudyError("unknown study", 404)
    if permission not in ("collaborate", "respond"):
        raise StudyError("permission must be collaborate or respond", 400)
    clean_email = str(email or "").strip().lower()
    db, ts = get_db(), now()

    # Check if an existing user matches clean_email
    target_uid = 0
    if clean_email:
        u = db.execute("SELECT id FROM users WHERE email=?", (clean_email,)).fetchone()
        if u:
            target_uid = int(u["id"])
        existing = db.execute(
            "SELECT * FROM study_shares WHERE study_slug=? AND shared_with_email=? AND permission=?",
            (st.slug, clean_email, permission),
        ).fetchone()
        if existing:
            if target_uid and not existing["shared_with_user_id"]:
                with write_lock, db:
                    db.execute(
                        "UPDATE study_shares SET shared_with_user_id=?, accepted_at=? WHERE id=?",
                        (target_uid, ts, existing["id"]),
                    )
                existing = db.execute("SELECT * FROM study_shares WHERE id=?", (existing["id"],)).fetchone()
            return dict(existing)

    token = secrets.token_urlsafe(18)
    with write_lock, db:
        cur = db.execute(
            "INSERT INTO study_shares (study_slug, shared_by, shared_with_user_id, shared_with_email, "
            "permission, token, created_at, accepted_at) VALUES (?,?,?,?,?,?,?,?)",
            (st.slug, int(shared_by or 0), target_uid, clean_email, permission,
             token, ts, ts if target_uid else ""),
        )
        sid = cur.lastrowid
    return dict(db.execute("SELECT * FROM study_shares WHERE id=?", (sid,)).fetchone())


def get_share_by_token(token: str) -> dict | None:
    if not token:
        return None
    row = get_db().execute(
        "SELECT ss.*, s.title AS study_title, s.status AS study_status, "
        "(SELECT COALESCE(NULLIF(name,''), email) FROM users u WHERE u.id=ss.shared_by) AS shared_by_label, "
        "(SELECT email FROM users u WHERE u.id=ss.shared_by) AS shared_by_email "
        "FROM study_shares ss JOIN studies s ON s.slug=ss.study_slug WHERE ss.token=?",
        (str(token).strip(),),
    ).fetchone()
    return dict(row) if row else None


def redeem_share(token: str, user: dict) -> dict | None:
    """Attach a shared link to ``user``'s account upon registration or sign-in.
    Guarantees 0 points are debited from ``user``."""
    share = get_share_by_token(token)
    if not share or not user:
        return None
    uid = int(user["id"])
    uemail = str(user.get("email") or "").strip().lower()
    st = Study.get(share["study_slug"])
    if not st:
        return None
    # If the user is already the study owner, nothing to bind—just return study info
    if st.owner_id == uid:
        return dict(share, already_owner=True, points_debited=0)

    db, ts = get_db(), now()
    # Check if this user already has a bound share row for this study & permission
    existing_user_share = db.execute(
        "SELECT * FROM study_shares WHERE study_slug=? AND shared_with_user_id=? AND permission=?",
        (st.slug, uid, share["permission"]),
    ).fetchone()
    if existing_user_share:
        return dict(existing_user_share, study_title=st.title, points_debited=0)

    with write_lock, db:
        # If the share row was unbound (or targeted to this user's email), bind it directly
        if share["shared_with_user_id"] in (0, uid) and (
            not share["shared_with_email"] or share["shared_with_email"] == uemail
        ):
            if not share["shared_with_email"]:
                # Generic reusable link: keep the reusable link intact and insert a bound record for this user
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
            # Another user redeeming a shared collaboration link -> grant them their own bound share entry
            new_tok = secrets.token_urlsafe(18)
            db.execute(
                "INSERT INTO study_shares (study_slug, shared_by, shared_with_user_id, shared_with_email, "
                "permission, token, created_at, accepted_at) VALUES (?,?,?,?,?,?,?,?)",
                (st.slug, share["shared_by"], uid, uemail, share["permission"], new_tok, ts, ts),
            )
    return dict(share, shared_with_user_id=uid, shared_with_email=uemail, points_debited=0)


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
        "AND (shared_with_user_id=? OR (shared_with_email != '' AND shared_with_email=?)) LIMIT 1",
        (slug, int(user_id), uemail),
    ).fetchone()
    return bool(row)


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
            "study_id": f"STU-{r['sid']:06d}",
            "title": r["title"],
            "status": r["status"],
            "updated_at": r["updated_at"],
            "started": r["started"] or 0,
            "complete": r["complete"] or 0,
            "owner_id": r["owner_id"] or 0,
            "owner_email": r["owner_email"] or "",
            "owner_name": r["owner_name"] or "",
            "permission": r["permission"],
            "token": r["token"],
            "points_debited": 0,
            "survey_link": f"/survey/{r['study_slug']}",
            "studio_link": f"/studio/#{r['study_slug']}" if r["permission"] == "collaborate" else "",
            "workspace_link": f"/workspace/#{r['study_slug']}" if r["permission"] == "collaborate" else "",
            "created_at": r["created_at"],
            "accepted_at": r["accepted_at"],
        })
    return out


def shares_for_study(slug: str) -> list[dict]:
    rows = get_db().execute(
        "SELECT ss.*, "
        "(SELECT email FROM users u WHERE u.id=ss.shared_with_user_id) AS bound_email, "
        "(SELECT name FROM users u WHERE u.id=ss.shared_with_user_id) AS bound_name "
        "FROM study_shares ss WHERE ss.study_slug=? ORDER BY ss.id DESC",
        (slug,),
    ).fetchall()
    return [dict(r) for r in rows]


def revoke_share(share_id: int) -> bool:
    db = get_db()
    with write_lock, db:
        cur = db.execute("DELETE FROM study_shares WHERE id=?", (int(share_id),))
        return cur.rowcount > 0
