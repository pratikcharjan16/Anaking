"""
STUDIO  -  the survey builder (token protected: ?token=<ADMIN_TOKEN>).

Page
    GET  /studio/                          builder UI

API (used by static/js/studio.js)
    GET  /api/studio/list                  all studies with respondent counts
    GET  /api/studio/study?slug=           one study incl. config
    GET  /api/studio/analysis?study=       quick analysis aggregates
    POST /api/studio/save                  create or update {slug?, title, cfg}
    POST /api/studio/status                {slug, status: draft|live|closed}
    POST /api/studio/delete                {slug}
    POST /api/studio/make_conjoint         {attributes, n_tasks, seed} -> design
"""

from __future__ import annotations

from flask import Blueprint, jsonify, render_template, request

from core.auth import admin_required
from core.conjoint import make_conjoint
from core.reporting import analysis_for
from models import Study, StudyError

from .helpers import error, json_body, records, study_arg

bp = Blueprint("studio", __name__)


@bp.get("/studio/")
@admin_required("text")
def page():
    return render_template("studio/studio.html")


@bp.get("/api/studio/list")
@admin_required()
def list_studies():
    return jsonify(Study.list_with_counts())


@bp.get("/api/studio/study")
@admin_required()
def get_study():
    study = Study.get(request.args.get("slug") or "")
    if not study:
        return jsonify({"error": "unknown study"}), 404
    return jsonify({"slug": study.slug, "title": study.title, "status": study.status,
                    "cfg": study.cfg, "updated_at": study.updated_at})


@bp.get("/api/studio/analysis")
@admin_required()
def analysis():
    slug = study_arg()
    return jsonify(analysis_for(records(slug), Study.cfg_of(slug)))


@bp.post("/api/studio/save")
@admin_required()
def save():
    try:
        return jsonify({"ok": True, "slug": Study.save(json_body())})
    except StudyError as e:
        return error(e)


@bp.post("/api/studio/status")
@admin_required()
def status():
    body = json_body()
    try:
        Study.set_status(body.get("slug") or "", body.get("status") or "")
    except StudyError as e:
        return error(e)
    return jsonify({"ok": True})


@bp.post("/api/studio/delete")
@admin_required()
def delete():
    try:
        Study.delete(json_body().get("slug") or "")
    except StudyError as e:
        return error(e)
    return jsonify({"ok": True})


@bp.post("/api/studio/make_conjoint")
@admin_required()
def conjoint():
    body = json_body()
    try:
        return jsonify(make_conjoint(body.get("attributes", []), int(body.get("n_tasks", 9)),
                                     int(body.get("seed", 1))))
    except (KeyError, ValueError, TypeError, ZeroDivisionError, IndexError) as e:
        return jsonify({"error": str(e)}), 400
