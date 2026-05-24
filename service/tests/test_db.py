"""B1: SQLite schema initializes idempotently with the required tables.

MVP append-only store: the `records`, `quarantine`, and per-user `tokens`
tables exist (no issues/clusters/FTS tables).
"""
from __future__ import annotations

import os
import sqlite3
import tempfile

import pytest

from app.db import connect, init_db, insert_token, lookup_token


def _fresh_db() -> str:
    p = os.path.join(tempfile.mkdtemp(), "fb.db")
    init_db(p)
    return p


def test_init_db_idempotent_and_tables_present():
    p = os.path.join(tempfile.mkdtemp(), "fb.db")
    init_db(p)
    init_db(p)  # idempotent: no error on second call

    con = sqlite3.connect(p)
    names = {
        r[0]
        for r in con.execute(
            "SELECT name FROM sqlite_master WHERE type IN ('table','view')"
        )
    }
    con.close()

    assert "records" in names, names
    assert "quarantine" in names, names
    assert "tokens" in names, names
    # Routing machinery was removed for the MVP: no issues/clusters tables.
    assert "issues" not in names, names
    assert "clusters" not in names, names


def test_tokens_check_rejects_empty_email_and_hash():
    con = connect(_fresh_db())
    try:
        with pytest.raises(sqlite3.IntegrityError):
            con.execute(
                "INSERT INTO tokens (email, token_hash, is_admin, created_at) "
                "VALUES (?,?,?,?)",
                ("", "h1", 0, "t"),
            )
        with pytest.raises(sqlite3.IntegrityError):
            con.execute(
                "INSERT INTO tokens (email, token_hash, is_admin, created_at) "
                "VALUES (?,?,?,?)",
                ("x@y.co", "", 0, "t"),
            )
    finally:
        con.close()


def test_reissue_for_same_email_appends_second_row():
    # Append-only: re-issuing for an existing email inserts a NEW row; both kept.
    con = connect(_fresh_db())
    try:
        id1 = insert_token(con, "dev@example.com", "h1", False, "t1")
        id2 = insert_token(con, "dev@example.com", "h2", False, "t2")
        assert id1 != id2
        n = con.execute(
            "SELECT count(*) FROM tokens WHERE email=?", ("dev@example.com",)
        ).fetchone()[0]
        assert n == 2, n
    finally:
        con.close()


def test_lookup_token_resolves_role():
    con = connect(_fresh_db())
    try:
        insert_token(con, "admin@example.com", "adminhash", True, "t")
        insert_token(con, "dev@example.com", "devhash", False, "t")

        admin = lookup_token(con, "adminhash")
        assert admin == {"email": "admin@example.com", "is_admin": True}, admin

        dev = lookup_token(con, "devhash")
        assert dev == {"email": "dev@example.com", "is_admin": False}, dev

        assert lookup_token(con, "missing") is None
    finally:
        con.close()
