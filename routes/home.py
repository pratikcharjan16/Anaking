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
    """Marketing landing: animated product demos + Google sign-in (or the way into
    the workspace when already signed in).  The project hub is /workspace/, and the
    classic study-list home stays at /?legacy=1."""
    if request.args.get("legacy") == "1":
        from core.security import allowed
        return render_template("home.html", studies=[s for s in Study.list_with_counts() if allowed(s["slug"])])
    return render_template("landing.html")


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
