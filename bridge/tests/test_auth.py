"""JWT gate: accepted via header and query, rejected every other way."""

from __future__ import annotations

import time

import jwt
import pytest
from fastapi import HTTPException

from bridge.auth import verify_token

from .conftest import TEST_SECRET, make_token


# ── unit ─────────────────────────────────────────────────────────────────────


def test_verify_token_returns_claims():
    claims = verify_token(make_token(sub="a@b.test"), TEST_SECRET)
    assert claims.subject == "a@b.test"
    assert claims.email == "a@b.test"
    assert claims.user_id == "user-1"


def test_verify_token_falls_back_to_sub_for_email():
    token = make_token(extra={"email": None})
    assert verify_token(token, TEST_SECRET).email == "local@adjutant.localhost"


@pytest.mark.parametrize(
    "token_factory, reason",
    [
        (lambda: make_token(ttl=-60), "expired"),
        (lambda: make_token(secret="clawdling-unit-test-other-secret-bbbb"), "wrong secret"),
        (lambda: jwt.encode({"sub": "a", "exp": int(time.time()) + 60}, None, algorithm="none"), "alg none"),
        (lambda: make_token(secret=TEST_SECRET, algorithm="HS512"), "alg confusion"),
        (lambda: jwt.encode({"exp": int(time.time()) + 60}, TEST_SECRET, algorithm="HS256"), "no sub"),
        (lambda: jwt.encode({"sub": "a"}, TEST_SECRET, algorithm="HS256"), "no exp"),
        (lambda: "not.a.jwt", "garbage"),
    ],
)
def test_verify_token_rejects(token_factory, reason):
    with pytest.raises(HTTPException) as exc:
        verify_token(token_factory(), TEST_SECRET)
    assert exc.value.status_code == 401, reason


# ── wire ─────────────────────────────────────────────────────────────────────


def test_header_token_is_accepted(client, auth):
    assert client.get("/api/sessions", headers=auth).status_code == 200


def test_query_token_is_accepted(client):
    # EventSource cannot set headers, so ?token= has to work on its own.
    resp = client.get(f"/api/sessions?token={make_token()}")
    assert resp.status_code == 200


def test_missing_token_is_401(client):
    resp = client.get("/api/sessions")
    assert resp.status_code == 401
    assert resp.headers["www-authenticate"] == "Bearer"


def test_expired_token_is_401(client):
    resp = client.get("/api/sessions", headers={"Authorization": f"Bearer {make_token(ttl=-1)}"})
    assert resp.status_code == 401


def test_wrong_secret_is_401(client):
    bad = make_token(secret="clawdling-unit-test-wrong-secret-cccc")
    resp = client.get("/api/sessions", headers={"Authorization": f"Bearer {bad}"})
    assert resp.status_code == 401


def test_expired_query_token_is_401_on_the_stream(client, auth):
    """The SSE path must not be a softer gate than the JSON paths."""
    from .conftest import spawn

    session = spawn(client, auth, cwd=None)
    sid = session["session_id"]
    resp = client.get(f"/api/sessions/{sid}/stream?token={make_token(ttl=-1)}")
    assert resp.status_code == 401


def test_malformed_authorization_header_does_not_fall_through_to_query(client):
    # A caller that sends a broken header gets a hard 401 rather than a silent
    # downgrade to whatever is in the URL.
    resp = client.get(
        f"/api/sessions?token={make_token()}",
        headers={"Authorization": "Token abc"},
    )
    assert resp.status_code == 401


def test_health_is_unauthenticated(client):
    body = client.get("/api/health").json()
    assert body["ok"] is True
    assert body["live"] == 0
