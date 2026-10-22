"""
Google sign-in (OpenID Connect, authorization-code flow).

    /auth/google        -> accounts.google.com  (this module builds the URL)
    /auth/google/callback
                        -> exchanges the code, verifies the ID token, signs the
                           person in; core.accounts owns what happens next.

Everything network-facing lives here so tests can patch one seam
(``exchange_and_verify``) and production keeps the real verification:
the ID token signature is checked against Google's published keys, and issuer,
audience and expiry are all enforced.  A token issued for a different OAuth
client is refused even if it verifies.
"""

from __future__ import annotations

import json
import urllib.parse
import urllib.request

AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth"
TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token"


class GoogleAuthError(Exception):
    """The sign-in round trip failed - shown to the user as a friendly message."""


def configured(client_id: str) -> bool:
    return bool(client_id)


def authorization_url(client_id: str, redirect_uri: str, state: str) -> str:
    params = {
        "client_id": client_id,
        "redirect_uri": redirect_uri,
        "response_type": "code",
        "scope": "openid email profile",
        "state": state,
        "prompt": "select_account",
        "access_type": "online",
    }
    return AUTH_ENDPOINT + "?" + urllib.parse.urlencode(params)


def exchange_and_verify(code: str, redirect_uri: str, client_id: str, client_secret: str) -> dict:
    """Trade the authorization code for identity claims.

    Returns the verified claims dict (``sub``, ``email``, ``email_verified``,
    ``name``, ``picture``).  Raises ``GoogleAuthError`` on anything wrong.
    """
    if not client_id or not client_secret:
        raise GoogleAuthError("Google sign-in is not configured on this server.")
    body = urllib.parse.urlencode({
        "code": code,
        "client_id": client_id,
        "client_secret": client_secret,
        "redirect_uri": redirect_uri,
        "grant_type": "authorization_code",
    }).encode()
    try:
        with urllib.request.urlopen(urllib.request.Request(
                TOKEN_ENDPOINT, data=body,
                headers={"Content-Type": "application/x-www-form-urlencoded"}), timeout=15) as resp:
            payload = json.loads(resp.read().decode())
    except Exception as exc:                                  # noqa: BLE001 - network/malformed
        raise GoogleAuthError("Could not reach Google to complete the sign-in.") from exc
    id_token = payload.get("id_token")
    if not id_token:
        raise GoogleAuthError("Google did not return an identity token.")
    return verify_id_token(id_token, client_id)


def verify_id_token(id_token: str, client_id: str) -> dict:
    """Signature + issuer + audience + expiry checks, via google-auth's verifier."""
    try:
        from google.oauth2 import id_token as google_id_token
        from google.auth.transport import urllib_request
    except ImportError as exc:                                 # pragma: no cover - deploy error
        raise GoogleAuthError("The google-auth package is not installed on this server.") from exc
    try:
        claims = google_id_token.verify_oauth2_token(
            id_token, urllib_request.Request(), audience=client_id)
    except Exception as exc:                                  # noqa: BLE001 - any verify failure
        raise GoogleAuthError("Google sign-in could not be verified.") from exc
    if str(claims.get("iss")) not in ("accounts.google.com", "https://accounts.google.com"):
        raise GoogleAuthError("Google sign-in came from an unexpected issuer.")
    if not claims.get("email") or not claims.get("email_verified"):
        raise GoogleAuthError("Your Google account needs a verified e-mail address.")
    return dict(claims)
