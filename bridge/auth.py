"""HS256 JWT verification for every bridge endpoint.

The cockpit mints a 15-minute token per call (src/lib/bridge-jwt.ts) and the
bridge verifies it with the same BRIDGE_SECRET. Two carriers are accepted:

  Authorization: Bearer <jwt>   the normal path, used by the Next.js proxy
  ?token=<jwt>                  the SSE path, because EventSource cannot set
                                request headers

The signature comparison itself is constant-time inside PyJWT, which uses
hmac.compare_digest. We never compare the secret ourselves; the one comparison
this module does make (the "Bearer " scheme prefix) is not a secret, but it is
still done with compare_digest so no future reader mistakes a plain == on an
auth header for an accepted pattern.
"""

from __future__ import annotations

import hmac
from dataclasses import dataclass

import jwt
from fastapi import HTTPException, Request, status

# The only algorithm we will ever accept. Passing a list to PyJWT is what stops
# alg=none and RS256-key-confusion attacks; never widen this.
ALGORITHMS = ["HS256"]

_BEARER = "bearer"


@dataclass(frozen=True)
class Claims:
    """The identity the cockpit asserted. Informational, not an authz decision."""

    subject: str
    email: str
    user_id: str | None = None


def _unauthorized(detail: str) -> HTTPException:
    return HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail=detail,
        headers={"WWW-Authenticate": "Bearer"},
    )


def extract_token(request: Request) -> str | None:
    """Pull the bearer token out of the header, falling back to ?token=."""
    header = request.headers.get("authorization") or ""
    if header:
        scheme, _, value = header.partition(" ")
        # Constant-time on the scheme so this never becomes the template for a
        # secret comparison. Case-insensitive per RFC 7235.
        if hmac.compare_digest(scheme.strip().lower(), _BEARER) and value.strip():
            return value.strip()
        # An Authorization header we cannot parse is a hard no, not a silent
        # fallthrough to the query param.
        return None
    token = request.query_params.get("token")
    return token.strip() if token and token.strip() else None


def verify_token(token: str, secret: str) -> Claims:
    """Verify an HS256 JWT. Raises HTTPException(401) on any failure."""
    try:
        payload = jwt.decode(
            token,
            secret,
            algorithms=ALGORITHMS,
            options={"require": ["exp"], "verify_exp": True},
        )
    except jwt.ExpiredSignatureError as exc:
        raise _unauthorized("token expired") from exc
    except jwt.InvalidTokenError as exc:
        # Covers a bad signature, a wrong/absent alg, malformed segments, and a
        # missing exp. The client gets one message; the reason stays here.
        raise _unauthorized("invalid token") from exc

    subject = payload.get("sub")
    if not isinstance(subject, str) or not subject:
        raise _unauthorized("token is missing sub")

    email = payload.get("email")
    if not isinstance(email, str) or not email:
        # The cockpit puts the email in `sub`; the contract names both.
        email = subject

    user_id = payload.get("user_id")
    return Claims(
        subject=subject,
        email=email,
        user_id=user_id if isinstance(user_id, str) and user_id else None,
    )


async def require_auth(request: Request) -> Claims:
    """FastAPI dependency. Attach to every route that touches a session."""
    token = extract_token(request)
    if not token:
        raise _unauthorized("missing bearer token")
    secret = request.app.state.config.secret
    return verify_token(token, secret)
