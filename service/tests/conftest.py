"""Shared pytest fixtures: an isolated app + TestClient per test.

Each test gets a fresh temp SQLite DB seeded with two per-user tokens (one
non-admin, one admin), minted directly via the db helpers. Auth is now the
hashed-token table — there is no environment/shared token.
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


def _mint(db_path: str, email: str, is_admin: bool) -> str:
    """Insert a token row directly and return its plaintext (test helper)."""
    plaintext = tokens_mod.generate_token()
    con = db_mod.connect(db_path)
    try:
        db_mod.insert_token(
            con, email, tokens_mod.hash_token(plaintext), is_admin, "2026-05-23T00:00:00Z"
        )
    finally:
        con.close()
    return plaintext


@pytest.fixture()
def client(monkeypatch):
    tmp = tempfile.mkdtemp()
    db_path = os.path.join(tmp, "fb.db")
    app = create_app(db_path=db_path)
    # Stash the db path so token-minting fixtures can seed the SAME db.
    app.state._test_db_path = db_path
    with TestClient(app) as c:
        yield c


@pytest.fixture()
def token(client) -> str:
    """A valid NON-admin token (may POST; may NOT read GET /feedback)."""
    return _mint(client.app.state._test_db_path, "dev@example.com", is_admin=False)


@pytest.fixture()
def admin_token(client) -> str:
    """A valid ADMIN token (may POST and read GET /feedback)."""
    return _mint(client.app.state._test_db_path, "admin@example.com", is_admin=True)
