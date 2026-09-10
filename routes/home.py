"""
HOME  -  landing page, admin sign-in, legacy redirects.

    GET  /            landing page with links to Survey, Studio and Admin
    GET  /login       sign-in form (enter the admin token once; a cookie covers Studio,
    POST /login       Admin and draft previews from then on)
    GET  /logout      end the admin session
    GET  /test        -> /survey/test         (old respondent links keep working)
    GET  /s/<slug>    -> /survey/<slug>
    GET  /healthz     liveness check
"""

from __future__ import annotations

from flask import (Blueprint, current_app, jsonify, redirect, render_template, request,
                   url_for)

from core.auth import is_signed_in, sign_in, sign_out, token_ok
from models import Study

bp = Blueprint("home", __name__)

DEFAULT_TOKEN = "beacon-admin"


def _safe_next(target: str | None) -> str:
    """Only allow same-site relative redirects."""
    if target and target.startswith("/") and not target.startswith("//"):
        return target
    return url_for("home.index")


@bp.get("/")
def index():
    bad_token = False
    if request.args.get("token"):              # ?token= on the home page signs you in
        bad_token = not token_ok(remember=True)
    return render_template("home.html", studies=Study.list_with_counts(),
                           signed_in=is_signed_in(), bad_token=bad_token)


@bp.route("/login", methods=["GET", "POST"])
def login():
    nxt = _safe_next(request.values.get("next"))
    error = None
    if request.method == "POST":
        if sign_in(request.form.get("token", "").strip()):
            return redirect(nxt)
        error = "That token is not correct."
    # Only mention the default token while the deployment still uses it (i.e. there is
    # no real secret yet); once ADMIN_TOKEN is set nothing is revealed.
    using_default = (current_app.config["ADMIN_TOKEN"] == DEFAULT_TOKEN
                     and not current_app.config.get("TESTING"))
    return render_template("login.html", next=nxt, error=error,
                           default_hint=DEFAULT_TOKEN if using_default else None,
                           signed_in=is_signed_in()), (200 if not error else 401)


@bp.get("/logout")
def logout():
    sign_out()
    return redirect(url_for("home.index"))


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
