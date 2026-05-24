"""SQLAlchemy engine/session layer for the loopback service.

Replaces the former raw ``sqlite3`` + ``schema.sql`` layer. The ORM models live
in ``app/orm.py``; production schema is managed by Alembic (see ``migrations/``),
while ``init_db`` provides a fast ``create_all`` bootstrap for tests / local dev.

Auth lookup joins ``tokens`` -> ``users`` and returns the resolved identity
(``user_id`` + ``email`` + ``is_admin``). The token-minting helpers
(``get_or_create_user`` + ``insert_token``) back ``issue_token.py`` and the test
fixtures.
"""
from __future__ import annotations

import os
from typing import Optional

from sqlalchemy import create_engine, event, select
from sqlalchemy.engine import Engine
from sqlalchemy.orm import Session, sessionmaker

from .orm import Base, Record, Token, User  # noqa: F401  (Record imported for metadata)


def make_engine(db_path: str) -> Engine:
    """Create a SQLite engine for ``db_path`` with FK enforcement enabled.

    ``check_same_thread=False`` lets the engine's pooled connection be shared
    across FastAPI's worker threads (each request gets its own Session). A
    per-connection ``PRAGMA foreign_keys=ON`` listener enforces the FK
    constraints SQLite otherwise ignores by default.
    """
    engine = create_engine(
        "sqlite:///" + db_path,
        connect_args={"check_same_thread": False},
    )

    @event.listens_for(engine, "connect")
    def _set_sqlite_pragma(dbapi_connection, connection_record):  # noqa: ANN001
        cursor = dbapi_connection.cursor()
        cursor.execute("PRAGMA foreign_keys=ON")
        cursor.close()

    return engine


def make_session_factory(engine: Engine) -> sessionmaker:
    """Return a ``sessionmaker`` bound to ``engine`` (one factory per engine)."""
    return sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)


def init_db(db_path: str) -> Engine:
    """Create the DB file + all tables via ``create_all``. Idempotent.

    Fast path for tests and local bootstrap; production uses Alembic migrations.
    Returns the engine so callers can build a session factory off it.
    """
    parent = os.path.dirname(os.path.abspath(db_path))
    if parent:
        os.makedirs(parent, exist_ok=True)
    engine = make_engine(db_path)
    Base.metadata.create_all(engine)
    return engine


def lookup_token(session: Session, token_hash: str) -> Optional[dict]:
    """Resolve a token by its sha256 hash to the owning user's identity.

    Returns ``{user_id, email, is_admin}`` or ``None`` if no token matches.
    """
    row = session.execute(
        select(Token.user_id, User.email, User.is_admin)
        .join(User, Token.user_id == User.id)
        .where(Token.token_hash == token_hash)
        .limit(1)
    ).first()
    if row is None:
        return None
    return {"user_id": row[0], "email": row[1], "is_admin": bool(row[2])}


def get_or_create_user(
    session: Session, email: str, is_admin: bool = False, created_at: str = ""
) -> User:
    """Return the user for ``email``, creating it if missing.

    If ``is_admin=True`` and the user exists but is non-admin, the user is
    PROMOTED to admin (idempotent). Caller commits.
    """
    user = session.execute(
        select(User).where(User.email == email)
    ).scalar_one_or_none()
    if user is None:
        user = User(email=email, is_admin=is_admin, created_at=created_at)
        session.add(user)
        session.flush()  # assign user.id without committing
        return user
    if is_admin and not user.is_admin:
        user.is_admin = True
    return user


def insert_token(
    session: Session, user: User, token_hash: str, created_at: str
) -> Token:
    """Append a NEW token row for ``user`` (append-only). Caller commits."""
    token = Token(user_id=user.id, token_hash=token_hash, created_at=created_at)
    session.add(token)
    session.flush()
    return token
