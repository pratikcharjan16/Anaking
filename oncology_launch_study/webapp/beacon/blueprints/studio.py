"""Studio builder: draft, edit, launch and analyse studies (token protected)."""

from __future__ import annotations

from flask import Blueprint, jsonify, render_template, request

from ..auth import admin_required
from ..conjoint import make_conjoint
from ..db import study_cfg, study_row
from ..reporting import analysis_for
from .. import services

bp = Blueprint("studio", __name__)


@bp.get("/studio")
@admin_required("text")
def page():
    return render_template("studio.html")


@bp.get("/api/studio/list")
@admin_required()
def list_studies():
    return jsonify(services.list_studies())


@bp.get("/api/studio/study")
@admin_required()
def get_study():
    row = study_row(request.args.get("slug") or "")
    if not row:
        return jsonify({"error": "unknown study"}), 404
    return jsonify({"slug": row["slug"], "title": row["title"], "status": row["status"],
                    "cfg": study_cfg(row), "updated_at": row["updated_at"]})


@bp.get("/api/studio/analysis")
@admin_required()
def analysis():
    slug = request.args.get("study") or "beacon"
    return jsonify(analysis_for(services.records_for(slug, "all"), services.cfg_of(slug)))


@bp.post("/api/studio/save")
@admin_required()
def save():
    try:
        slug = services.save_study(request.get_json(silent=True) or {})
    except services.StudyError as e:
        return jsonify({"error": e.message}), e.status
    return jsonify({"ok": True, "slug": slug})


@bp.post("/api/studio/status")
@admin_required()
def status():
    body = request.get_json(silent=True) or {}
    try:
        services.set_status(body.get("slug") or "", body.get("status") or "")
    except services.StudyError as e:
        return jsonify({"error": e.message}), e.status
    return jsonify({"ok": True})


@bp.post("/api/studio/delete")
@admin_required()
def delete():
    body = request.get_json(silent=True) or {}
    try:
        services.delete_study(body.get("slug") or "")
    except services.StudyError as e:
        return jsonify({"error": e.message}), e.status
    return jsonify({"ok": True})


@bp.post("/api/studio/make_conjoint")
@admin_required()
def conjoint():
    body = request.get_json(silent=True) or {}
    try:
        return jsonify(make_conjoint(body.get("attributes", []), int(body.get("n_tasks", 9)),
                                     int(body.get("seed", 1))))
    except (KeyError, ValueError, TypeError, ZeroDivisionError, IndexError) as e:
        return jsonify({"error": str(e)}), 400
