"""Standard WSGI entry point for hosting platforms.

Configure the host to load this file and expose its ``application`` callable. The
application factory remains in ``app.py`` so local development and Gunicorn can keep
their existing startup commands.
"""

from __future__ import annotations

import os
import sys


PROJECT_ROOT = os.path.dirname(os.path.abspath(__file__))
if PROJECT_ROOT not in sys.path:
    sys.path.insert(0, PROJECT_ROOT)

from app import create_app  # noqa: E402  (project path must be set first)

application = create_app()
