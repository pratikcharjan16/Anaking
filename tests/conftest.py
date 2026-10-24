import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

# Never use a developer's real .env admin credentials in the test suite.
os.environ["ADMIN_USERNAME"] = "Anaking.admin"
os.environ["ADMIN_PASSWORD"] = "test-only-admin-password"

from app import create_app  # noqa: E402


@pytest.fixture()
def app(tmp_path):
    return create_app({
        "TESTING": True,
        "STAFF_AUTH": False,
        "WORKSPACE_ENABLED": False,  # legacy compatibility; workspace tests explicitly enable it
        "DB_PATH": str(tmp_path / "test.db"),
        "VOICE_DIR": str(tmp_path / "voice"),
        "NARRATION_DIR": str(tmp_path / "narration"),
        "MEDIA_DIR": str(tmp_path / "media"),
    })


@pytest.fixture()
def client(app):
    return app.test_client()
