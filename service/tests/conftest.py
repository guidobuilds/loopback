"""Shared pytest fixtures: an isolated app + TestClient per test.

Each test gets a fresh temp SQLite DB; the `token`/`admin_token` fixtures mint
per-user tokens directly via the ORM helpers (get_or_create_user + insert_token).
Auth is the hashed-token table joined to users — there is no environment/shared
token, and `is_admin` lives on the User.
"""
from __future__ import annotations

import json
import os
import tempfile
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app import db as db_mod
from app import tokens as tokens_mod
from app.main import create_app

FIXTURES = Path(__file__).parent / "fixtures"


def load_fixture(name: str) -> dict:
    return json.loads((FIXTURES / name).read_text(encoding="utf-8"))


def _mint(app, email: str, is_admin: bool) -> str:
    """Mint a token for `email` via the ORM helpers; return its plaintext.

    Reuses the app's own engine/session factory so the token lands in the SAME
    DB the TestClient app reads. Re-issuing for an existing email reuses the user
    (and promotes to admin if is_admin=True).
    """
    plaintext = tokens_mod.generate_token()
    session = app.state.session_factory()
    try:
        user = db_mod.get_or_create_user(
            session, email, is_admin=is_admin, created_at="2026-05-23T00:00:00Z"
        )
        db_mod.insert_token(
            session, user, tokens_mod.hash_token(plaintext), "2026-05-23T00:00:00Z"
        )
        session.commit()
    finally:
        session.close()
    return plaintext


@pytest.fixture()
def client(monkeypatch):
    tmp = tempfile.mkdtemp()
    db_path = os.path.join(tmp, "fb.db")
    app = create_app(db_path=db_path)
    with TestClient(app) as c:
        yield c


@pytest.fixture()
def token(client) -> str:
    """A valid NON-admin token (may POST; may NOT read GET /feedback)."""
    return _mint(client.app, "dev@example.com", is_admin=False)


@pytest.fixture()
def admin_token(client) -> str:
    """A valid ADMIN token (may POST and read GET /feedback)."""
    return _mint(client.app, "admin@example.com", is_admin=True)
