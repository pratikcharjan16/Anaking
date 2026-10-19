"""
HOME  -  landing page and legacy redirects.

    GET  /            landing page with links to Survey, Studio and Admin
    GET  /test        -> /survey/test         (old respondent links keep working)
    GET  /s/<slug>    -> /survey/<slug>
    GET  /healthz     liveness check
"""

from __future__ import annotations

from flask import Blueprint, current_app, jsonify, redirect, render_template, request, url_for

from models import Study

bp = Blueprint("home", __name__)


@bp.get("/")
def index():
    if current_app.config["WORKSPACE_ENABLED"] and request.args.get("legacy") != "1":
        return render_template("workspace.html")
    from core.security import allowed
    return render_template("home.html", studies=[s for s in Study.list_with_counts() if allowed(s["slug"])])


@bp.get("/test")
def legacy_test():
    return redirect(url_for("survey.beacon_survey_test"), 301)


@bp.get('/s/<regex("[a-zA-Z0-9\\-]+"):slug>')
@bp.get('/s/<regex("[a-zA-Z0-9\\-]+"):slug>/test')
def legacy_study(slug):
    tail = "/test" if request.path.endswith("/test") else ""
    qs = ("?" + request.query_string.decode()) if request.query_string else ""
    return redirect(f"/survey/{slug}{tail}{qs}", 301)


@bp.get("/healthz")
def healthz():
    return jsonify({"ok": True, "version": current_app.config.get("VERSION", "")})
