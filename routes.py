"""
All HTTP routes for the platform, in one place.

Two blueprints:

``user``   - respondent-facing survey pages + the JSON API used by ``static/js/survey.js``
``admin``  - token-protected Studio builder, dashboard, exports and resets

Routes stay thin: validation and persistence live in ``models.py``; computation
(conjoint, QC, reporting) lives in ``core/``.
"""

from __future__ import annotations

import base64
import csv
import io
import json
import os
import re
import time

from flask import (Blueprint, Response, abort, current_app, jsonify, render_template,
                   request, send_from_directory)

from core import xlsx_export
from core.auth import admin_required, token_ok
from core.conjoint import assignment_for, make_conjoint
from core.qc import qc_flags
from core.reporting import analysis_for, build_sheets, flatten
from core.seed import load_task_map
from core.survey_spec import TERMINATE_TEXT
from models import Respondent, Study, StudyError

user_bp = Blueprint("user", __name__)
admin_bp = Blueprint("admin", __name__)

SLUG = r'<regex("[a-zA-Z0-9\-]+"):slug>'


# ====================================================================================
# SHARED HELPERS
# ====================================================================================
def _json_body() -> dict:
    return request.get_json(silent=True) or {}


def _error(e: StudyError):
    return jsonify({"error": e.message}), e.status


def _records(slug: str, scope: str = "all") -> list[dict]:
    """Respondents of a study as dicts with ``answers`` and a flattened ``flat`` row."""
    study = Study.get(slug)
    if not study:
        return []
    out = []
    for r in Respondent.for_study(study.id, scope):
        rec = {k: r[k] for k in r.keys()}
        rec["answers"] = Respondent(r).answers()
        rec["is_test_label"] = "test" if r["is_test"] else "real"
        rec["flat"] = flatten(rec, rec["answers"], study.cfg)
        out.append(rec)
    return out


def _attachment(data: bytes, mimetype: str, filename: str, extra: dict | None = None):
    headers = {"Content-Disposition": f"attachment; filename={filename}",
               "Cache-Control": "no-store", **(extra or {})}
    return Response(data, mimetype=mimetype, headers=headers)


def _stamp() -> str:
    return time.strftime("%Y%m%d_%H%M%S")


# ====================================================================================
# USER  -  survey pages
# ====================================================================================
def _survey_page(slug: str, preview_token: str | None):
    study = Study.get(slug)
    if not study:
        abort(404, "unknown study")
    if not study.is_live and not token_ok(preview_token or ""):
        return render_template("user/not_live.html"), 403
    return render_template("user/survey.html", slug=slug)


@user_bp.get("/")
@user_bp.get("/index.html")
@user_bp.get("/test")
def beacon_survey():
    return _survey_page("beacon", None)


@user_bp.get(f"/s/{SLUG}")
@user_bp.get(f"/s/{SLUG}/test")
def study_survey(slug):
    return _survey_page(slug, request.args.get("preview"))


@user_bp.get("/audio/<path:name>")
def audio(name):
    """Narration clips; ``send_from_directory`` handles Range requests for seeking."""
    if not name.endswith(".mp3"):
        abort(404)
    return send_from_directory(os.path.join(current_app.static_folder, "audio"), name,
                               mimetype="audio/mpeg", conditional=True)


# ====================================================================================
# USER  -  survey API
# ====================================================================================
@user_bp.get("/api/spec")
@user_bp.get(f"/api/spec/{SLUG}")
def spec(slug="beacon"):
    study = Study.get(slug)
    if not study:
        return jsonify({"error": "unknown study"}), 404
    cfg = study.cfg
    conj = cfg.get("conjoint")
    if conj and isinstance(conj.get("tasks"), list):
        conj = dict(conj, tasks={str(i + 1): t for i, t in enumerate(conj["tasks"])})
    return jsonify({
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
    })


@user_bp.post("/api/start")
def start():
    body = _json_body()
    slug = body.get("study") or "beacon"
    study = Study.get(slug)
    if not study:
        return jsonify({"error": "unknown study"}), 404
    if not study.is_live:
        return jsonify({"error": "study not live"}), 403
    resp = Respondent.create(study, bool(body.get("is_test")),
                             request.headers.get("User-Agent", ""))
    design = study.cfg.get("conjoint")
    task_map = load_task_map() if slug == "beacon" else None
    assignment = (assignment_for(resp.code, design, task_map) if design
                  else {"task_order": [], "alt_positions": {}})
    resp.set_assignment(assignment["task_order"], assignment["alt_positions"])
    return jsonify({"session_id": resp.session_id, "respondent_code": resp.code,
                    "is_test": resp.is_test, "study": slug,
                    "task_order": assignment["task_order"],
                    "alt_positions": assignment["alt_positions"],
                    "from_prebuilt_map": resp.code in (task_map or {})})


@user_bp.post("/api/save")
def save():
    body = _json_body()
    resp = Respondent.by_session(body.get("session_id"))
    if resp is None:
        return jsonify({"error": "unknown session"}), 400
    return jsonify({"ok": True, "status": resp.persist(body)})


@user_bp.post("/api/submit")
def submit():
    body = _json_body()
    resp = Respondent.by_session(body.get("session_id"))
    if resp is None:
        return jsonify({"error": "unknown session"}), 400
    resp.persist(body)
    seconds = float(body.get("elapsed_seconds") or 0)
    resp.complete(seconds)
    cfg = Study.get_by_id(resp.study_id).cfg
    return jsonify({"ok": True, "respondent_code": resp.code,
                    **qc_flags(resp.answers(), seconds, cfg)})


@user_bp.get("/api/progress")
def progress():
    resp = Respondent.by_session(request.args.get("sid"))
    return jsonify(resp.progress() if resp else {"exists": False})


@user_bp.post("/api/voice")
def voice():
    body = _json_body()
    qid = str(body.get("qid") or "")
    ext = str(body.get("ext") or "webm").lower()
    if ext not in ("webm", "mp4", "ogg", "opus", "m4a"):
        return jsonify({"error": "unsupported format"}), 400
    if not re.fullmatch(r"[A-Za-z0-9]+", qid):
        return jsonify({"error": "bad question id"}), 400
    try:
        raw = base64.b64decode(body.get("data") or "", validate=True)
    except (ValueError, TypeError):
        return jsonify({"error": "bad audio payload"}), 400
    if not raw or len(raw) > 2_500_000:
        return jsonify({"error": "audio too large"}), 400
    resp = Respondent.by_session(body.get("session_id"))
    if resp is None:
        return jsonify({"error": "unknown session"}), 400
    voice_dir = current_app.config["VOICE_DIR"]
    os.makedirs(voice_dir, exist_ok=True)
    fname = resp.voice_filename(qid, ext)
    with open(os.path.join(voice_dir, fname), "wb") as f:
        f.write(raw)
    return jsonify({"ok": True, "file": fname})


# ====================================================================================
# ADMIN  -  pages
# ====================================================================================
@admin_bp.get("/admin")
@admin_required("text")
def dashboard():
    return render_template("admin/dashboard.html")


@admin_bp.get("/studio")
@admin_required("text")
def studio():
    return render_template("admin/studio.html")


# ====================================================================================
# ADMIN  -  studio API
# ====================================================================================
@admin_bp.get("/api/studio/list")
@admin_required()
def studio_list():
    return jsonify(Study.list_with_counts())


@admin_bp.get("/api/studio/study")
@admin_required()
def studio_get():
    study = Study.get(request.args.get("slug") or "")
    if not study:
        return jsonify({"error": "unknown study"}), 404
    return jsonify({"slug": study.slug, "title": study.title, "status": study.status,
                    "cfg": study.cfg, "updated_at": study.updated_at})


@admin_bp.get("/api/studio/analysis")
@admin_required()
def studio_analysis():
    slug = request.args.get("study") or "beacon"
    return jsonify(analysis_for(_records(slug), Study.cfg_of(slug)))


@admin_bp.post("/api/studio/save")
@admin_required()
def studio_save():
    try:
        return jsonify({"ok": True, "slug": Study.save(_json_body())})
    except StudyError as e:
        return _error(e)


@admin_bp.post("/api/studio/status")
@admin_required()
def studio_status():
    body = _json_body()
    try:
        Study.set_status(body.get("slug") or "", body.get("status") or "")
    except StudyError as e:
        return _error(e)
    return jsonify({"ok": True})


@admin_bp.post("/api/studio/delete")
@admin_required()
def studio_delete():
    try:
        Study.delete(_json_body().get("slug") or "")
    except StudyError as e:
        return _error(e)
    return jsonify({"ok": True})


@admin_bp.post("/api/studio/make_conjoint")
@admin_required()
def studio_make_conjoint():
    body = _json_body()
    try:
        return jsonify(make_conjoint(body.get("attributes", []), int(body.get("n_tasks", 9)),
                                     int(body.get("seed", 1))))
    except (KeyError, ValueError, TypeError, ZeroDivisionError, IndexError) as e:
        return jsonify({"error": str(e)}), 400


# ====================================================================================
# ADMIN  -  dashboard data, reset, exports
# ====================================================================================
@admin_bp.get("/api/admin/data")
@admin_required()
def admin_data():
    slug = request.args.get("study") or "beacon"
    scope = request.args.get("scope") or "all"
    cfg = Study.cfg_of(slug)
    records = _records(slug, scope)
    complete = [r for r in records if r["status"] == "complete"]
    screened = [r for r in records if r["status"] == "screened_out"]
    in_prog = [r for r in records if r["status"] == "in_progress"]

    def flags(r):
        return qc_flags(r["answers"], r["elapsed_seconds"] or 0, cfg,
                        r["status"] or "complete")["flags"]

    divisions, settings = {}, {}
    for r in complete:
        d = r["flat"].get("census_division") or "(unset)"
        s = r["flat"].get("practice_setting_group") or "(unset)"
        divisions[d] = divisions.get(d, 0) + 1
        settings[s] = settings.get(s, 0) + 1
    metrics = cfg.get("metrics") or {}
    intent_q, pct_q = metrics.get("intent_q"), metrics.get("pct_q")
    intent = [float(r["answers"].get(intent_q, {}).get("_") or 0) for r in complete] \
        if intent_q else []
    pct = [float(r["answers"].get(pct_q, {}).get("_") or 0) for r in complete] if pct_q else []
    return jsonify({
        "study": slug, "scope": scope,
        "generated": time.strftime("%Y-%m-%d %H:%M:%S", time.gmtime()) + " UTC",
        "counts": {"total": len(records), "complete": len(complete),
                   "screened_out": len(screened), "in_progress": len(in_prog)},
        "quota": {"census_division": divisions, "practice_setting": settings},
        "headlines": {
            "top2box_intent_pct": round(100 * sum(1 for v in intent if v >= 4) / len(intent), 1)
            if intent else None,
            "mean_pct_eligible": round(sum(pct) / len(pct), 1) if pct else None,
            "mean_minutes": round(sum(r["elapsed_seconds"] or 0 for r in complete) / 60 /
                                  len(complete), 1) if complete else None},
        "qc_flagged": [{"code": r["respondent_code"], "flags": flags(r)}
                       for r in complete if flags(r)],
        "recent": [{
            "code": r["respondent_code"], "is_test": bool(r["is_test"]),
            "status": r["status"], "started_at": r["started_at"],
            "completed_at": r["completed_at"],
            "minutes": round((r["elapsed_seconds"] or 0) / 60, 1),
            "screen_out": r["screen_out_at"] or "", "flags": flags(r),
        } for r in records[-25:]][::-1],
        "conjoint": {"n_tasks": (cfg.get("conjoint") or {}).get("n_tasks", 0)},
        "token": current_app.config["ADMIN_TOKEN"],
    })


@admin_bp.post("/admin/reset")
@admin_required()
def admin_reset():
    slug = request.args.get("study") or "beacon"
    scope = request.args.get("scope") or "test"
    try:
        n = Respondent.reset(Study.get(slug), scope)
    except StudyError as e:
        return _error(e)
    return jsonify({"ok": True, "scope": scope, "study": slug, "deleted_respondents": n})


@admin_bp.get("/admin/export.xlsx")
@admin_required("text")
def export_xlsx():
    slug = request.args.get("study") or "beacon"
    scope = request.args.get("scope") or "all"
    sheets = build_sheets(_records(slug, scope), scope, Study.cfg_of(slug))
    data, backend = xlsx_export.build_workbook(sheets)
    return _attachment(
        data, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        f"{slug}_responses_{scope}_{_stamp()}.xlsx", {"X-Export-Backend": backend})


@admin_bp.get("/admin/export.csv")
@admin_required("text")
def export_csv():
    slug = request.args.get("study") or "beacon"
    scope = request.args.get("scope") or "all"
    flat = [r["flat"] for r in _records(slug, scope)]
    if not flat:
        return Response("respondent_code\n", mimetype="text/csv")
    cols = list(flat[0].keys())
    for f in flat:
        for k in f:
            if k not in cols:
                cols.append(k)
    buf = io.StringIO()
    w = csv.DictWriter(buf, fieldnames=cols, extrasaction="ignore")
    w.writeheader()
    w.writerows(flat)
    return _attachment(buf.getvalue().encode(), "text/csv; charset=utf-8",
                       f"{slug}_responses_{scope}_{_stamp()}.csv")


@admin_bp.get("/admin/export.json")
@admin_required("text")
def export_json():
    slug = request.args.get("study") or "beacon"
    scope = request.args.get("scope") or "all"
    out = [{k: v for k, v in r.items() if k != "flat"} for r in _records(slug, scope)]
    return _attachment(json.dumps(out, indent=2).encode(), "application/json; charset=utf-8",
                       f"{slug}_responses_{scope}_{_stamp()}.json")


@admin_bp.get("/admin/voice/<path:name>")
@admin_required("text")
def admin_voice(name):
    name = os.path.basename(name)
    ctype = ("audio/mp4" if name.endswith((".m4a", ".mp4"))
             else "audio/ogg" if name.endswith((".ogg", ".opus")) else "audio/webm")
    return send_from_directory(current_app.config["VOICE_DIR"], name, mimetype=ctype,
                               conditional=True)


def register_routes(app) -> None:
    app.register_blueprint(user_bp)
    app.register_blueprint(admin_bp)
