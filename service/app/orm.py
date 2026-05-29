"""SQLAlchemy 2.0 ORM models for the loopback service.

These are the PERSISTENCE models (the DB schema). They are kept deliberately
separate from ``app/models.py`` — the Pydantic WIRE models that conform to
``feedback-record.schema.json`` — so the storage layer and the wire contract can
evolve independently.

Identity model (normalized): a ``User`` is identified by a unique ``email`` and
carries ``is_admin``. A user has many ``Token`` rows (re-issuing a token for an
existing email appends a new token row but reuses the same user). Every
``Record`` links to the authenticated submitter via ``user_id`` (NOT NULL FK).
The ``Quarantine`` table mirrors the redaction-quarantine store and has no user
link (it holds records that failed the server-side redaction re-check).
"""
from __future__ import annotations

from typing import List, Optional

from sqlalchemy import CheckConstraint, ForeignKey, Integer, Text
from sqlalchemy.orm import (
    DeclarativeBase,
    Mapped,
    mapped_column,
    relationship,
)


class Base(DeclarativeBase):
    pass


class User(Base):
    """A person, identified by a unique email. ``is_admin`` lives here."""

    __tablename__ = "users"
    __table_args__ = (
        CheckConstraint("length(trim(email)) > 0", name="ck_users_email_nonempty"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    email: Mapped[str] = mapped_column(Text, nullable=False, unique=True)
    # SQLite has no native bool: SQLAlchemy maps Boolean -> INTEGER 0/1.
    is_admin: Mapped[bool] = mapped_column(nullable=False, default=False)
    created_at: Mapped[str] = mapped_column(Text, nullable=False)

    tokens: Mapped[List["Token"]] = relationship(
        back_populates="user", cascade="all, delete-orphan"
    )
    records: Mapped[List["Record"]] = relationship(back_populates="user")


class Token(Base):
    """Per-user issued API token (sha256 hash at rest, never the plaintext).

    Append-only: re-issuing for an existing email inserts a NEW row pointing at
    the SAME user. ``is_admin`` is NOT here — it is a User attribute now.
    """

    __tablename__ = "tokens"
    __table_args__ = (
        CheckConstraint(
            "length(trim(token_hash)) > 0", name="ck_tokens_token_hash_nonempty"
        ),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    user_id: Mapped[int] = mapped_column(
        ForeignKey("users.id"), nullable=False
    )
    token_hash: Mapped[str] = mapped_column(Text, nullable=False, unique=True)
    created_at: Mapped[str] = mapped_column(Text, nullable=False)

    user: Mapped["User"] = relationship(back_populates="tokens")


class Record(Base):
    """The append-only feedback store. ``id`` is the SERVER-assigned primary key.

    Mirrors the former ``records`` table EXCEPT ``anon_user_id`` is removed and a
    NOT NULL ``user_id`` FK (the authenticated submitter) is added.
    """

    __tablename__ = "records"

    id: Mapped[str] = mapped_column(Text, primary_key=True)  # server-assigned id (fb_<uuid>)
    schema_version: Mapped[int] = mapped_column(Integer, nullable=False)
    artifact_kind: Mapped[str] = mapped_column(Text, nullable=False)  # skill|agent|artifact
    artifact_id: Mapped[Optional[str]] = mapped_column(Text)
    artifact_version: Mapped[Optional[str]] = mapped_column(Text)
    artifact_repo: Mapped[Optional[str]] = mapped_column(Text)
    summary: Mapped[str] = mapped_column(Text, nullable=False)
    work_type: Mapped[Optional[str]] = mapped_column(Text)
    evidence_excerpt: Mapped[Optional[str]] = mapped_column(Text)
    timestamp: Mapped[Optional[str]] = mapped_column(Text)
    severity: Mapped[Optional[str]] = mapped_column(Text)
    confidence: Mapped[Optional[str]] = mapped_column(Text)
    cluster_key: Mapped[Optional[str]] = mapped_column(Text)
    client_plugin: Mapped[Optional[str]] = mapped_column(Text)
    client_harness: Mapped[Optional[str]] = mapped_column(Text)  # telemetry
    created_at: Mapped[str] = mapped_column(Text, nullable=False)  # server receive time
    user_id: Mapped[int] = mapped_column(
        ForeignKey("users.id"), nullable=False
    )

    user: Mapped["User"] = relationship(back_populates="records")


class Quarantine(Base):
    """Records that failed the server-side redaction re-check (design §7).

    These are NOT placed in the main ``records`` table and have no user link.
    """

    __tablename__ = "quarantine"

    id: Mapped[str] = mapped_column(Text, primary_key=True)
    reason: Mapped[str] = mapped_column(Text, nullable=False)
    payload: Mapped[str] = mapped_column(Text, nullable=False)  # full raw JSON
    created_at: Mapped[str] = mapped_column(Text, nullable=False)
