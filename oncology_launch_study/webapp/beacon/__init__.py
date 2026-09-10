"""
PROJECT BEACON - survey platform (Flask).

A multi-study platform: every survey is a "study" - a JSON config (sections, questions,
TPP text, walkthrough scenes, conjoint design, QC rules) stored in SQLite. Studies can be
drafted, edited, launched live and closed independently; respondent data is captured and
exported per study. The original PROJECT BEACON oncology study is seeded as ``beacon``.

Routes
  Respondent engine            (blueprints/survey.py)
    GET  /  /test  /s/<slug>  /s/<slug>/test   (?preview=<token> for drafts)
    GET  /api/spec/<slug>   /api/progress?sid=
    POST /api/start  /api/save  /api/submit  /api/voice
  Studio builder (?token=...)  (blueprints/studio.py)
    GET  /studio  /api/studio/list  /api/studio/study?slug=  /api/studio/analysis?study=
    POST /api/studio/save  /api/studio/status  /api/studio/delete  /api/studio/make_conjoint
  Admin / export (?token=...)  (blueprints/admin.py)
    GET  /admin  /api/admin/data  /admin/export.{xlsx,csv,json}  /admin/voice/<file>
    POST /admin/reset
"""

from __future__ import annotations

import os

from flask import Flask, jsonify, request
from werkzeug.exceptions import HTTPException
from werkzeug.routing import BaseConverter

from . import db as _db
from .config import WEBAPP_DIR, Config
from .seed import seed_beacon

__version__ = "3.0.0"


class RegexConverter(BaseConverter):
    """``<regex("pattern"):name>`` URL converter."""

    def __init__(self, url_map, *items):
        super().__init__(url_map)
        self.regex = items[0]


def create_app(config: type | dict | None = None) -> Flask:
    app = Flask(
        __name__,
        static_folder=os.path.join(WEBAPP_DIR, "static"),
        static_url_path="",
        template_folder=os.path.join(WEBAPP_DIR, "templates"),
    )
    app.config.from_object(Config)
    if isinstance(config, dict):
        app.config.update(config)
    elif config is not None:
        app.config.from_object(config)
    app.url_map.converters["regex"] = RegexConverter

    _db.init_app(app)
    with app.app_context():
        _db.init_db()
        seed_beacon()

    from .blueprints import admin_bp, studio_bp, survey_bp
    app.register_blueprint(survey_bp)
    app.register_blueprint(studio_bp)
    app.register_blueprint(admin_bp)

    @app.after_request
    def _headers(resp):
        resp.headers.setdefault("X-Content-Type-Options", "nosniff")
        if request.path.startswith(("/api/", "/admin")):
            resp.headers["Cache-Control"] = "no-store"
        return resp

    @app.errorhandler(HTTPException)
    def _http_error(e):
        wants_json = request.path.startswith("/api/") or \
            request.accept_mimetypes.best == "application/json"
        if wants_json:
            return jsonify({"error": e.description}), e.code
        return e.description, e.code, {"Content-Type": "text/plain; charset=utf-8"}

    @app.get("/healthz")
    def healthz():
        return jsonify({"ok": True, "version": __version__})

    return app
