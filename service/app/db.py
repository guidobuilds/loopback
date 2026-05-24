"""SQLite database layer for the loopback service.

Provides idempotent schema initialization and a small connection helper. The
schema (the append-only ``records`` store + ``quarantine`` + per-user
``tokens``) lives in ``schema.sql`` alongside this module.
"""
from __future__ import annotations

import os
import sqlite3
from pathlib import Path
from typing import Optional

_SCHEMA_PATH = Path(__file__).with_name("schema.sql")


def _schema_sql() -> str:
    return _SCHEMA_PATH.read_text(encoding="utf-8")


def connect(path: str) -> sqlite3.Connection:
    """Open a SQLite connection with sensible defaults for the service."""
    con = sqlite3.connect(path, check_same_thread=False)
    con.row_factory = sqlite3.Row
    con.execute("PRAGMA foreign_keys = ON")
    return con


def init_db(path: str) -> None:
    """Create the schema if it does not already exist. Idempotent."""
    parent = os.path.dirname(os.path.abspath(path))
    if parent:
        os.makedirs(parent, exist_ok=True)
    con = connect(path)
    try:
        con.executescript(_schema_sql())
        _migrate(con)
        con.commit()
    finally:
        con.close()


def _migrate(con: sqlite3.Connection) -> None:
    """Idempotent column migrations for DBs created before a column existed.

    ``CREATE TABLE IF NOT EXISTS`` never alters an existing table, so additive
    columns must be applied here. Safe to run on every startup.
    """
    cols = {row["name"] for row in con.execute("PRAGMA table_info(records)")}
    if "client_harness" not in cols:
        con.execute("ALTER TABLE records ADD COLUMN client_harness TEXT")


def insert_token(
    con: sqlite3.Connection,
    email: str,
    token_hash: str,
    is_admin: bool,
    created_at: str,
) -> int:
    """Append a NEW token row (append-only: never updates/deletes prior rows).

    Re-issuing for an existing email inserts a fresh row; all prior rows are
    retained. Returns the new row's ``id``.
    """
    cur = con.execute(
        "INSERT INTO tokens (email, token_hash, is_admin, created_at) "
        "VALUES (?,?,?,?)",
        (email, token_hash, 1 if is_admin else 0, created_at),
    )
    con.commit()
    return int(cur.lastrowid)


def lookup_token(con: sqlite3.Connection, token_hash: str) -> Optional[dict]:
    """Resolve a token by its sha256 hash. Returns ``{email, is_admin}`` or None."""
    row = con.execute(
        "SELECT email, is_admin FROM tokens WHERE token_hash = ? LIMIT 1",
        (token_hash,),
    ).fetchone()
    if row is None:
        return None
    return {"email": row["email"], "is_admin": bool(row["is_admin"])}
