"""B1: SQLAlchemy ORM schema + identity model.

The normalized store has the `users`, `tokens`, `records`, and `quarantine`
tables (no issues/clusters/FTS tables). Identity is collapsed to a `User`
(unique email, `is_admin`) with one-to-many `tokens`; every `record` links to a
user via a NOT NULL FK.
"""
from __future__ import annotations

import os
import tempfile

import pytest
from sqlalchemy import inspect, select
from sqlalchemy.exc import IntegrityError

from app.db import (
    get_or_create_user,
    init_db,
    insert_token,
    lookup_token,
    make_session_factory,
)
from app.orm import Record, Token, User


def _fresh():
    """Return (engine, session_factory) bound to a brand-new temp DB."""
    p = os.path.join(tempfile.mkdtemp(), "fb.db")
    engine = init_db(p)
    return engine, make_session_factory(engine)


def test_init_db_idempotent_and_tables_present():
    p = os.path.join(tempfile.mkdtemp(), "fb.db")
    init_db(p)
    init_db(p)  # idempotent: create_all is a no-op the second time.

    engine = init_db(p)
    names = set(inspect(engine).get_table_names())

    assert "users" in names, names
    assert "tokens" in names, names
    assert "records" in names, names
    assert "quarantine" in names, names
    # Routing machinery was removed for the MVP: no issues/clusters tables.
    assert "issues" not in names, names
    assert "clusters" not in names, names


def test_email_unique_rejects_duplicate():
    _engine, factory = _fresh()
    session = factory()
    try:
        session.add(User(email="dup@example.com", is_admin=False, created_at="t"))
        session.commit()
        session.add(User(email="dup@example.com", is_admin=True, created_at="t"))
        with pytest.raises(IntegrityError):
            session.commit()
    finally:
        session.rollback()
        session.close()


def test_check_rejects_empty_email():
    _engine, factory = _fresh()
    session = factory()
    try:
        session.add(User(email="   ", is_admin=False, created_at="t"))
        with pytest.raises(IntegrityError):
            session.commit()
    finally:
        session.rollback()
        session.close()


def test_check_rejects_empty_token_hash():
    _engine, factory = _fresh()
    session = factory()
    try:
        user = get_or_create_user(session, "x@y.co", created_at="t")
        session.flush()
        session.add(Token(user_id=user.id, token_hash="   ", created_at="t"))
        with pytest.raises(IntegrityError):
            session.commit()
    finally:
        session.rollback()
        session.close()


def test_one_user_many_tokens_reissue_reuses_user():
    # Re-issuing for the same email reuses the SAME user_id and appends a 2nd token.
    _engine, factory = _fresh()
    session = factory()
    try:
        u1 = get_or_create_user(session, "dev@example.com", created_at="t")
        insert_token(session, u1, "h1", "t1")
        session.commit()

        u2 = get_or_create_user(session, "dev@example.com", created_at="t")
        insert_token(session, u2, "h2", "t2")
        session.commit()

        assert u1.id == u2.id, (u1.id, u2.id)
        n_users = len(session.execute(select(User)).scalars().all())
        assert n_users == 1, n_users
        tokens = session.execute(
            select(Token).where(Token.user_id == u1.id)
        ).scalars().all()
        assert len(tokens) == 2, [t.token_hash for t in tokens]
    finally:
        session.close()


def test_get_or_create_user_promotes_to_admin():
    _engine, factory = _fresh()
    session = factory()
    try:
        u = get_or_create_user(session, "p@example.com", is_admin=False, created_at="t")
        session.commit()
        assert u.is_admin is False
        # Re-fetch with --admin promotes the existing non-admin user.
        again = get_or_create_user(session, "p@example.com", is_admin=True, created_at="t")
        session.commit()
        assert again.id == u.id
        assert again.is_admin is True
    finally:
        session.close()


def test_lookup_token_returns_identity():
    _engine, factory = _fresh()
    session = factory()
    try:
        admin = get_or_create_user(session, "admin@example.com", is_admin=True, created_at="t")
        insert_token(session, admin, "adminhash", "t")
        dev = get_or_create_user(session, "dev@example.com", is_admin=False, created_at="t")
        insert_token(session, dev, "devhash", "t")
        session.commit()

        got_admin = lookup_token(session, "adminhash")
        assert got_admin == {
            "user_id": admin.id,
            "email": "admin@example.com",
            "is_admin": True,
        }, got_admin

        got_dev = lookup_token(session, "devhash")
        assert got_dev == {
            "user_id": dev.id,
            "email": "dev@example.com",
            "is_admin": False,
        }, got_dev

        assert lookup_token(session, "missing") is None
    finally:
        session.close()


def test_record_requires_user_id():
    # records.user_id is NOT NULL: inserting a record without it fails.
    _engine, factory = _fresh()
    session = factory()
    try:
        session.add(Record(
            id="fb_x",
            schema_version=1,
            artifact_kind="skill",
            summary="s",
            created_at="t",
            # user_id intentionally omitted
        ))
        with pytest.raises(IntegrityError):
            session.commit()
    finally:
        session.rollback()
        session.close()


def test_record_user_id_fk_must_exist():
    # A record's user_id must reference an existing user (FK enforced via PRAGMA).
    _engine, factory = _fresh()
    session = factory()
    try:
        session.add(Record(
            id="fb_y",
            schema_version=1,
            artifact_kind="skill",
            summary="s",
            created_at="t",
            user_id=99999,  # no such user
        ))
        with pytest.raises(IntegrityError):
            session.commit()
    finally:
        session.rollback()
        session.close()
