#!/usr/bin/env python3
"""
PROJECT BEACON - survey research platform (Flask).

    python3 app.py [--port 8000] [--host 0.0.0.0] [--admin-token TOKEN] [--debug]

Production:  gunicorn -w 2 -b 0.0.0.0:8000 "app:create_app()"

Project layout
    app.py          this file - application factory + CLI entry point
    config.py       settings (env-overridable)
    models.py       SQLite schema + Study / Respondent / Answer models
    routes.py       every HTTP route (user + admin blueprints)
    core/           domain logic: conjoint, QC rules, reporting, seed, xlsx, auth
    templates/      user/ (survey pages)  admin/ (dashboard, studio)
    static/         css/  js/  images/  audio/
    data/           survey.db (runtime) + design/ (conjoint design inputs)
    uploads/        respondent voice recordings (runtime)
    tests/          pytest suite     scripts/  live-server checks + demo seeder
"""

from __future__ import annotations

import argparse
import os

from flask import Flask, jsonify, request
from werkzeug.exceptions import HTTPException
from werkzeug.routing import BaseConverter

import models
from config import CONFIGS, DATA_DIR, UPLOAD_DIR, Config
from core.seed import seed_beacon
from routes import register_routes

__version__ = "3.1.0"


class RegexConverter(BaseConverter):
    """``<regex("pattern"):name>`` URL converter."""

    def __init__(self, url_map, *items):
        super().__init__(url_map)
        self.regex = items[0]


def create_app(config: str | type | dict | None = None) -> Flask:
    """Application factory.

    ``config`` may be a name from ``config.CONFIGS`` ("development", "production",
    "testing"), a config class, or a dict of overrides (handy in tests).
    """
    app = Flask(__name__, static_folder="static", static_url_path="/static",
                template_folder="templates")
    app.config.from_object(Config)
    if isinstance(config, str):
        app.config.from_object(CONFIGS[config])
    elif isinstance(config, dict):
        app.config.update(config)
    elif config is not None:
        app.config.from_object(config)
    app.url_map.converters["regex"] = RegexConverter

    os.makedirs(os.path.dirname(app.config["DB_PATH"]) or DATA_DIR, exist_ok=True)
    os.makedirs(app.config["VOICE_DIR"] or UPLOAD_DIR, exist_ok=True)

    models.init_app(app)
    with app.app_context():
        models.init_db()
        seed_beacon()

    register_routes(app)

    @app.after_request
    def _headers(resp):
        resp.headers.setdefault("X-Content-Type-Options", "nosniff")
        if request.path.startswith(("/api/", "/admin")):
            resp.headers["Cache-Control"] = "no-store"
        return resp

    @app.errorhandler(HTTPException)
    def _http_error(e):
        if request.path.startswith("/api/") or \
                request.accept_mimetypes.best == "application/json":
            return jsonify({"error": e.description}), e.code
        return e.description, e.code, {"Content-Type": "text/plain; charset=utf-8"}

    @app.get("/healthz")
    def healthz():
        return jsonify({"ok": True, "version": __version__})

    return app


def main() -> None:
    ap = argparse.ArgumentParser(description="PROJECT BEACON survey platform")
    ap.add_argument("--port", type=int, default=int(os.environ.get("PORT", 8000)))
    ap.add_argument("--host", default=os.environ.get("HOST", "0.0.0.0"))
    ap.add_argument("--admin-token", default=None,
                    help="Studio/admin token (default: $ADMIN_TOKEN or 'beacon-admin')")
    ap.add_argument("--debug", action="store_true", help="Flask debugger + auto-reload")
    args = ap.parse_args()

    app = create_app("development" if args.debug else None)
    if args.admin_token:
        app.config["ADMIN_TOKEN"] = args.admin_token
    token = app.config["ADMIN_TOKEN"]

    shown = "localhost" if args.host in ("0.0.0.0", "::") else args.host
    print(f"PROJECT BEACON platform serving on http://{args.host}:{args.port}")
    print(f"  respondent link : http://{shown}:{args.port}/")
    print(f"  studio builder  : http://{shown}:{args.port}/studio?token={token}")
    print(f"  admin dashboard : http://{shown}:{args.port}/admin?token={token}", flush=True)
    app.run(host=args.host, port=args.port, debug=args.debug, threaded=True)


if __name__ == "__main__":
    main()
