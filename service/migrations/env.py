"""Alembic environment for the loopback service.

The DB URL is derived from the ``DB_PATH`` env var (default ``/tmp/loopback.db``)
to match ``app/main.py`` and ``issue_token.py`` — there is no hard-coded URL in
``alembic.ini``. ``target_metadata`` is the ORM ``Base.metadata`` so autogenerate
and the drift-guard test compare against the live models. ``render_as_batch`` is
on for SQLite (ALTER TABLE via copy-and-move).

Run from the ``service/`` directory so ``app`` is importable
(``prepend_sys_path = .`` in alembic.ini):

    cd service && DB_PATH=/data/loopback.db alembic upgrade head
"""
from __future__ import annotations

import os

from sqlalchemy import create_engine

from alembic import context

# app is importable because alembic.ini sets prepend_sys_path = . and alembic is
# invoked from the service/ dir.
from app.orm import Base

config = context.config

target_metadata = Base.metadata


def _db_url() -> str:
    db_path = os.environ.get("DB_PATH", "/tmp/loopback.db")
    return "sqlite:///" + db_path


def run_migrations_offline() -> None:
    """Run migrations in 'offline' mode (emit SQL without a live connection)."""
    context.configure(
        url=_db_url(),
        target_metadata=target_metadata,
        literal_binds=True,
        dialect_opts={"paramstyle": "named"},
        render_as_batch=True,
    )
    with context.begin_transaction():
        context.run_migrations()


def run_migrations_online() -> None:
    """Run migrations in 'online' mode (against a live SQLite connection)."""
    connectable = create_engine(_db_url())
    with connectable.connect() as connection:
        context.configure(
            connection=connection,
            target_metadata=target_metadata,
            render_as_batch=True,
        )
        with context.begin_transaction():
            context.run_migrations()


if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()
