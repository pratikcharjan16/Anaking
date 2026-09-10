#!/usr/bin/env python3
"""
PROJECT BEACON platform - entry point.

    python3 app.py [--port 8000] [--host 0.0.0.0] [--admin-token TOKEN] [--debug]

Or with any WSGI server:   gunicorn -w 2 -b 0.0.0.0:8000 "app:app"
"""

from __future__ import annotations

import argparse
import os

from beacon import create_app

app = create_app()


def main() -> None:
    ap = argparse.ArgumentParser(description="PROJECT BEACON survey platform")
    ap.add_argument("--port", type=int, default=int(os.environ.get("PORT", 8000)))
    ap.add_argument("--host", default=os.environ.get("HOST", "0.0.0.0"))
    ap.add_argument("--admin-token", default=None,
                    help="Studio/admin token (default: $ADMIN_TOKEN or 'beacon-admin')")
    ap.add_argument("--debug", action="store_true", help="Flask debugger + auto-reload")
    args = ap.parse_args()

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
