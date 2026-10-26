import json
from unittest import mock

import pytest

from core.google_auth import (GoogleAuthError, configured, exchange_and_verify,
                              verify_id_token)


class _Response:
    def __init__(self, payload):
        self.payload = payload

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False

    def read(self):
        return json.dumps(self.payload).encode("utf-8")


def test_google_oauth_requires_both_web_client_credentials():
    assert configured("client-id", "client-secret")
    assert not configured("client-id", "")
    assert not configured("", "client-secret")


def test_token_exchange_verifies_the_returned_identity_token(monkeypatch):
    monkeypatch.setattr("core.google_auth.urllib.request.urlopen",
                        lambda *_args, **_kwargs: _Response({"id_token": "signed-id-token"}))
    with mock.patch("core.google_auth.verify_id_token", return_value={"sub": "google-user"}) as verify:
        claims = exchange_and_verify("authorization-code", "https://example.test/callback",
                                     "client-id", "client-secret")
    assert claims == {"sub": "google-user"}
    verify.assert_called_once_with("signed-id-token", "client-id")


def test_token_exchange_rejects_invalid_or_error_responses(monkeypatch):
    monkeypatch.setattr("core.google_auth.urllib.request.urlopen",
                        lambda *_args, **_kwargs: _Response([]))
    with pytest.raises(GoogleAuthError, match="invalid sign-in response"):
        exchange_and_verify("code", "https://example.test/callback", "client-id", "secret")

    monkeypatch.setattr("core.google_auth.urllib.request.urlopen",
                        lambda *_args, **_kwargs: _Response({"error": "invalid_grant"}))
    with pytest.raises(GoogleAuthError, match="Please try again"):
        exchange_and_verify("code", "https://example.test/callback", "client-id", "secret")


def test_id_token_verification_uses_google_auth_requests_transport():
    from google.auth.transport.requests import Request
    from google.oauth2 import id_token as google_id_token

    claims = {"iss": "https://accounts.google.com", "email": "person@example.org",
              "email_verified": True, "sub": "google-user"}
    with mock.patch.object(google_id_token, "verify_oauth2_token", return_value=claims) as verify:
        result = verify_id_token("signed-id-token", "client-id")
    assert result == claims
    args, kwargs = verify.call_args
    assert args[0] == "signed-id-token" and isinstance(args[1], Request)
    assert kwargs == {"audience": "client-id"}


def test_id_token_requires_verified_email():
    from google.oauth2 import id_token as google_id_token

    claims = {"iss": "https://accounts.google.com", "email": "person@example.org",
              "email_verified": False}
    with mock.patch.object(google_id_token, "verify_oauth2_token", return_value=claims):
        with pytest.raises(GoogleAuthError, match="verified e-mail"):
            verify_id_token("signed-id-token", "client-id")
