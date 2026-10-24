"""
Application configuration.

Every setting can be overridden with an environment variable so the same code runs on a
laptop, in a container or behind a production WSGI server.
"""

import os

from dotenv import load_dotenv

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.path.join(BASE_DIR, "data")
UPLOAD_DIR = os.path.join(BASE_DIR, "uploads")

# Load local development secrets without overriding real process environment variables.
# The .env file is ignored by Git; production should use the host's secret manager.
load_dotenv(os.path.join(BASE_DIR, ".env"), override=False)


class Config:
    PRODUCTION = os.environ.get("ANAKING_ENV") == "production"
    WORKSPACE_ENABLED = os.environ.get("WORKSPACE_ENABLED", "1") == "1"
    # Credentials are required across Studio, Workspace and Admin by default.
    STAFF_AUTH = os.environ.get("STAFF_AUTH", "1") == "1"
    SESSION_COOKIE_HTTPONLY = True
    SESSION_COOKIE_SAMESITE = "Lax"
    SESSION_COOKIE_SECURE = PRODUCTION
    LOCAL_AI_URL = os.environ.get("LOCAL_AI_URL", "")
    LOCAL_AI_MODEL = os.environ.get("LOCAL_AI_MODEL", "")

    # ---- platform accounts (Google sign-in) ------------------------------------
    # OAuth client from Google Cloud Console -> APIs & Services -> Credentials.
    # With these unset the Google button reports "not configured" and only the
    # explicitly enabled DEV_LOGIN shortcut works (never in production).
    GOOGLE_CLIENT_ID = os.environ.get("GOOGLE_CLIENT_ID", "")
    GOOGLE_CLIENT_SECRET = os.environ.get("GOOGLE_CLIENT_SECRET", "")
    # Protected username/password admin. Leave ADMIN_PASSWORD empty to disable
    # password sign-in for this account; Google admins can use ADMIN_EMAILS below.
    ADMIN_USERNAME = os.environ.get("ADMIN_USERNAME", "Anaking.admin").strip() or "Anaking.admin"
    ADMIN_PASSWORD = os.environ.get("ADMIN_PASSWORD", "")
    # Comma-separated emails that become platform admins (auto-approved) on first
    # sign-in - the bootstrap so the admin console can never be locked out.
    ADMIN_EMAILS = [e.strip().lower() for e in os.environ.get("ADMIN_EMAILS", "").split(",") if e.strip()]
    # Development-only e-mail sign-in shortcut (demo / QA without Google credentials).
    # Forced off whenever ANAKING_ENV=production, whatever the environment says.
    DEV_LOGIN = (not PRODUCTION) and os.environ.get("DEV_LOGIN", "0") == "1"
    SECRET_KEY = os.environ.get("SECRET_KEY", "change-me-in-production")

    # SQLite database holding studies, respondents and answers.
    DB_PATH = os.environ.get("DB_PATH", os.path.join(DATA_DIR, "survey.db"))

    # Respondent voice recordings (never committed to git).
    VOICE_DIR = os.environ.get("VOICE_DIR", os.path.join(UPLOAD_DIR, "voice"))

    # Narration clips uploaded from the Studio for walkthrough scenes (per study).
    NARRATION_DIR = os.environ.get("NARRATION_DIR", os.path.join(UPLOAD_DIR, "narration"))
    NARRATION_MAX_BYTES = 8 * 1024 * 1024

    # Images / video attached to questions from the Studio (per study).
    MEDIA_DIR = os.environ.get("MEDIA_DIR", os.path.join(UPLOAD_DIR, "media"))
    MEDIA_MAX_BYTES = 10 * 1024 * 1024

    # Pre-generated conjoint design + respondent task map for the seeded BEACON study.
    DESIGN_PATH = os.path.join(DATA_DIR, "design", "design.json")
    TASKMAP_PATH = os.path.join(DATA_DIR, "design", "respondent_task_map.csv")

    # Largest accepted request body (voice clips are base64, capped at ~2.5 MB raw).
    MAX_CONTENT_LENGTH = 12 * 1024 * 1024

    SEND_FILE_MAX_AGE_DEFAULT = 3600
    JSON_SORT_KEYS = False


class DevelopmentConfig(Config):
    DEBUG = True


class ProductionConfig(Config):
    DEBUG = False


class TestingConfig(Config):
    TESTING = True
    STAFF_AUTH = os.environ.get("STAFF_AUTH", "0") == "1"


CONFIGS = {
    "development": DevelopmentConfig,
    "production": ProductionConfig,
    "testing": TestingConfig,
}
