"""Alembic migration tests: greenfield baseline + drift guard.

1. ``alembic upgrade head`` on a fresh temp SQLite DB creates the 4 tables.
2. After upgrading, autogenerate against ``app.orm.Base.metadata`` produces NO
   diff — i.e. the hand-written ``0001_initial`` migration stays in lockstep with
   the ORM models (drift guard).

Uses the Alembic Python API (``alembic.config.Config`` + ``command.upgrade``)
pointed at a temp DB via the ``DB_PATH`` env var that ``migrations/env.py`` reads.
"""
from __future__ import annotations

import os
import tempfile
from pathlib import Path

from alembic import command
from alembic.autogenerate import compare_metadata
from alembic.config import Config
from alembic.migration import MigrationContext
from sqlalchemy import create_engine, inspect

from app.orm import Base

SVC_ROOT = Path(__file__).resolve().parent.parent
ALEMBIC_INI = SVC_ROOT / "alembic.ini"


def _alembic_config(db_path: str) -> Config:
    cfg = Config(str(ALEMBIC_INI))
    # alembic.ini uses a relative script_location ("migrations"); pin it to the
    # absolute path so the test is CWD-independent.
    cfg.set_main_option("script_location", str(SVC_ROOT / "migrations"))
    # env.py derives the URL from DB_PATH.
    os.environ["DB_PATH"] = db_path
    return cfg


def test_upgrade_head_creates_four_tables():
    db_path = os.path.join(tempfile.mkdtemp(), "mig.db")
    cfg = _alembic_config(db_path)
    command.upgrade(cfg, "head")

    engine = create_engine("sqlite:///" + db_path)
    names = set(inspect(engine).get_table_names())
    engine.dispose()
    for t in ("users", "tokens", "records", "quarantine"):
        assert t in names, (t, names)


def test_no_drift_between_migration_and_orm():
    db_path = os.path.join(tempfile.mkdtemp(), "drift.db")
    cfg = _alembic_config(db_path)
    command.upgrade(cfg, "head")

    engine = create_engine("sqlite:///" + db_path)
    with engine.connect() as conn:
        ctx = MigrationContext.configure(
            conn,
            opts={"render_as_batch": True, "compare_type": True},
        )
        diff = compare_metadata(ctx, Base.metadata)
    engine.dispose()
    assert diff == [], "schema drift between 0001_initial and app.orm: %r" % (diff,)
