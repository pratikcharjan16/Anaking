"""
Respondent-facing routes: the survey page for any study plus the JSON API that
``static/survey.js`` talks to.
"""

from __future__ import annotations

import base64
import os
import re

from flask import (Blueprint, abort, current_app, jsonify, render_template, request,
                   send_from_directory)

from ..auth import token_ok
from ..db import get_db, study_row
from .. import services

bp = Blueprint("survey", __name__)

SLUG = r'<regex("[a-zA-Z0-9\-]+"):slug>'


# ---------------------------------------------------------------- pages
def _survey_page(slug: str, preview_token: str | None):
    row = study_row(slug)
    if not row:
        abort(404, "unknown study")
    if row["status"] != "live" and not token_ok(preview_token or ""):
        return render_template("not_live.html"), 403
    return render_template("index.html", slug=slug)


@bp.get("/")
@bp.get("/index.html")
@bp.get("/test")
def beacon_survey():
    return _survey_page("beacon", None)


@bp.get(f"/s/{SLUG}")
@bp.get(f"/s/{SLUG}/test")
def study_survey(slug):
    return _survey_page(slug, request.args.get("preview"))


@bp.get("/audio/<path:name>")
def audio(name):
    """Narration clips. ``send_from_directory`` handles Range requests for seeking."""
    if not name.endswith(".mp3"):
        abort(404)
    return send_from_directory(os.path.join(current_app.static_folder, "audio"), name,
                               mimetype="audio/mpeg", conditional=True)


# ---------------------------------------------------------------- API
@bp.get("/api/spec")
@bp.get(f"/api/spec/{SLUG}")
def spec(slug="beacon"):
    out = services.spec_for(slug)
    if out is None:
        return jsonify({"error": "unknown study"}), 404
    return jsonify(out)


@bp.post("/api/start")
def start():
    body = request.get_json(silent=True) or {}
    try:
        out = services.start_session(body.get("study") or "beacon", bool(body.get("is_test")),
                                     request.headers.get("User-Agent", ""))
    except services.StudyError as e:
        return jsonify({"error": e.message}), e.status
    return jsonify(out)


@bp.post("/api/save")
def save():
    body = request.get_json(silent=True) or {}
    result = services.persist_answers(body)
    if result is None:
        return jsonify({"error": "unknown session"}), 400
    return jsonify({"ok": True, "status": result[0]})


@bp.post("/api/submit")
def submit():
    body = request.get_json(silent=True) or {}
    out = services.complete_session(body)
    if out is None:
        return jsonify({"error": "unknown session"}), 400
    return jsonify(out)


@bp.get("/api/progress")
def progress():
    return jsonify(services.progress_for(request.args.get("sid")))


@bp.post("/api/voice")
def voice():
    body = request.get_json(silent=True) or {}
    sid = body.get("session_id") or ""
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
    row = get_db().execute(
        "SELECT r.respondent_code, s.slug FROM respondents r JOIN studies s ON s.id=r.study_id "
        "WHERE r.session_id=?", (sid,)).fetchone()
    if not row:
        return jsonify({"error": "unknown session"}), 400
    voice_dir = current_app.config["VOICE_DIR"]
    os.makedirs(voice_dir, exist_ok=True)
    fname = f"{row['slug']}__{row['respondent_code']}_{qid}.{ext}"
    with open(os.path.join(voice_dir, fname), "wb") as f:
        f.write(raw)
    return jsonify({"ok": True, "file": fname})
