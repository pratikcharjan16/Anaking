#!/usr/bin/env python3
"""
PROJECT BEACON - survey research platform (Flask).

    python3 app.py [--port 8000] [--host 0.0.0.0] [--debug]

Production:  gunicorn -w 2 -b 0.0.0.0:8000 "app:create_app()"

Project layout
    app.py          this file - application factory + CLI entry point
    config.py       settings (env-overridable)
    models.py       SQLite schema + Study / Respondent / Answer models
    routes/         one module per app: home.py, survey.py, studio.py, admin.py
    core/           domain logic: conjoint, QC rules, reporting, seed, xlsx
    templates/      home.html + survey/  studio/  admin/
    static/         css/  js/  images/  audio/
    data/           survey.db (runtime) + design/ (conjoint design inputs)
    uploads/        respondent voice recordings (runtime)
    tests/          pytest suite     scripts/  live-server checks + demo seeder
"""

from __future__ import annotations

import argparse
import os

from flask import Flask, jsonify, request, url_for
from werkzeug.exceptions import HTTPException
from werkzeug.middleware.proxy_fix import ProxyFix
from werkzeug.routing import BaseConverter

import models
from config import CONFIGS, DATA_DIR, UPLOAD_DIR, Config
from core.seed import seed_beacon
from routes import register_routes

__version__ = "3.4.0"


def _static_stamp(folder: str) -> str:
    """Newest mtime in ``static/`` - a free cache-buster that changes on every deploy.

    Every asset URL goes through ``asset()``, so a browser can never keep serving a
    stylesheet or script from an earlier build (which used to be handled with a different
    hand-typed ``?v=`` string per template - and forgotten in a few places).
    """
    newest = 0
    for base, _dirs, files in os.walk(folder or "."):
        for name in files:
            try:
                newest = max(newest, int(os.path.getmtime(os.path.join(base, name))))
            except OSError:
                continue
    return str(newest or 0)


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
    if app.config["PRODUCTION"] and (not app.config["STAFF_AUTH"] or app.config["SECRET_KEY"] == "change-me-in-production"):
        raise RuntimeError("Production requires STAFF_AUTH=1 and a strong SECRET_KEY.")
    if app.config["WORKSPACE_ENABLED"] and not os.path.isfile(os.path.join(app.static_folder, "js", "workspace.js")):
        raise RuntimeError("Workspace is incomplete. Leave WORKSPACE_ENABLED=0 until workspace.js is installed and tested.")
    from core.security import init_security
    init_security(app)
    app.url_map.converters["regex"] = RegexConverter
    # behind a reverse proxy / hosted preview: trust X-Forwarded-* so redirects and
    # generated URLs know the real scheme and host
    app.wsgi_app = ProxyFix(app.wsgi_app, x_for=1, x_proto=1, x_host=1)
    app.config["VERSION"] = __version__
    # One build stamp for every static asset; ASSET_VERSION pins it in a fixed deployment.
    app.config["ASSET_VERSION"] = os.environ.get("ASSET_VERSION") or _static_stamp(app.static_folder)

    @app.template_global()
    def asset(path: str) -> str:
        """URL for a static asset, stamped with the running build."""
        return f"{url_for('static', filename=path.lstrip('/'))}?v={app.config['ASSET_VERSION']}"

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
        # everything is always fresh - stale cached UI caused repeated "not working"
        # reports; the platform is small enough that no-store costs nothing
        if request.path.startswith(("/api/", "/admin", "/static/")) or "text/html" in (resp.mimetype or ""):
            resp.headers["Cache-Control"] = "no-store"
        return resp

    @app.errorhandler(HTTPException)
    def _http_error(e):
        if request.path.startswith("/api/") or \
                request.accept_mimetypes.best == "application/json":
            return jsonify({"error": e.description}), e.code
        return e.description, e.code, {"Content-Type": "text/plain; charset=utf-8"}

    return app


def main() -> None:
    ap = argparse.ArgumentParser(description="PROJECT BEACON survey platform")
    ap.add_argument("--port", type=int, default=int(os.environ.get("PORT", 8000)))
    ap.add_argument("--host", default=os.environ.get("HOST", "0.0.0.0"))
    ap.add_argument("--debug", action="store_true", help="Flask debugger + auto-reload")
    args = ap.parse_args()

    app = create_app("development" if args.debug else None)

    # Jinja caches compiled templates unless the app is in debug mode, so editing a .html file
    # while the dev server runs would keep serving the old markup until a restart.  Reload them
    # here; production (gunicorn) keeps the cache.
    app.config["TEMPLATES_AUTO_RELOAD"] = True
    app.jinja_env.auto_reload = True

    shown = "localhost" if args.host in ("0.0.0.0", "::") else args.host
    base = f"http://{shown}:{args.port}"
    print(f"PROJECT BEACON platform serving on http://{args.host}:{args.port}")
    print(f"  home            : {base}/")
    print(f"  survey          : {base}/survey/      (test mode: {base}/survey/test)")
    print(f"  studio builder  : {base}/studio/")
    print(f"  admin dashboard : {base}/admin/", flush=True)
    app.run(host=args.host, port=args.port, debug=args.debug, threaded=True)


if __name__ == "__main__":
    main()
