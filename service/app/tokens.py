"""Shared token primitives for the loopback service.

STDLIB ONLY (``secrets``, ``hashlib``) so this module can be imported by BOTH
the FastAPI app (``app.main``) and the stdlib-only admin CLI
(``service/issue_token.py``) without dragging in FastAPI.

Auth model: a presented bearer token is hashed and looked up in the ``tokens``
table. There is no environment/shared token. A token with ``is_admin = 1`` may
read ``GET /feedback``; any valid token may ``POST /feedback``.
"""
from __future__ import annotations

import hashlib
import secrets

# Human-recognizable prefix so leaked tokens are greppable / scannable, plus 256
# bits of url-safe entropy. ``token_urlsafe(32)`` yields ~43 url-safe chars.
TOKEN_PREFIX = "lpbk_"


def generate_token() -> str:
    """Mint a new high-entropy plaintext token (shown to the admin ONCE)."""
    return TOKEN_PREFIX + secrets.token_urlsafe(32)


def hash_token(plaintext: str) -> str:
    """Return the sha256 hex digest stored/looked up for a token.

    No per-token salt and no slow KDF: the token is high-entropy random (not a
    human password), so it is not brute-forceable. A fast hash keeps the auth
    lookup cheap and index-backed.
    """
    return hashlib.sha256(plaintext.encode("utf-8")).hexdigest()
