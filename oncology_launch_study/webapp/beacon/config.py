"""
Application configuration.

Everything can be overridden through environment variables so the same code runs
unchanged on a laptop, in a container or behind a WSGI server.
"""

from __future__ import annotations

import os

PACKAGE_DIR = os.path.dirname(os.path.abspath(__file__))
WEBAPP_DIR = os.path.dirname(PACKAGE_DIR)
PROJECT_DIR = os.path.dirname(WEBAPP_DIR)


class Config:
    # Shared secret for the Studio builder and the admin dashboard (?token=...).
    ADMIN_TOKEN = os.environ.get("ADMIN_TOKEN", "beacon-admin")

    # SQLite database holding studies, respondents and answers.
    DB_PATH = os.environ.get("BEACON_DB", os.path.join(WEBAPP_DIR, "survey.db"))

    # Voice recordings uploaded by respondents (never committed to git).
    VOICE_DIR = os.environ.get("BEACON_VOICE_DIR", os.path.join(WEBAPP_DIR, "voice"))

    # Pre-generated conjoint design + respondent task map for the seeded beacon study.
    DESIGN_PATH = os.path.join(PROJECT_DIR, "output", "design.json")
    TASKMAP_PATH = os.path.join(PROJECT_DIR, "output", "respondent_task_map.csv")

    # Largest accepted request body (voice clips are base64 and capped at ~2.5 MB raw).
    MAX_CONTENT_LENGTH = 4 * 1024 * 1024

    # Static assets are versioned by query-string in the templates; never cache API output.
    SEND_FILE_MAX_AGE_DEFAULT = 3600
    JSON_SORT_KEYS = False


class TestConfig(Config):
    TESTING = True
    ADMIN_TOKEN = "test-token"
