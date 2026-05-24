"""initial greenfield baseline: users, tokens, records, quarantine

Revision ID: 0001
Revises:
Create Date: 2026-05-24

Greenfield baseline — no legacy-row migration. Creates the normalized identity
tables (``users`` 1->N ``tokens``, ``is_admin`` on the user) plus the
append-only ``records`` store (FK ``user_id`` NOT NULL) and the ``quarantine``
table. Must stay in lockstep with ``app/orm.py`` (the drift-guard test in
``tests/test_migrations.py`` autogenerates against the ORM metadata and asserts
NO diff).
"""
from typing import Sequence, Union

import sqlalchemy as sa

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "0001"
down_revision: Union[str, None] = None
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "users",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("email", sa.Text(), nullable=False),
        sa.Column("is_admin", sa.Boolean(), nullable=False),
        sa.Column("created_at", sa.Text(), nullable=False),
        sa.CheckConstraint(
            "length(trim(email)) > 0", name="ck_users_email_nonempty"
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("email"),
    )
    op.create_table(
        "tokens",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("user_id", sa.Integer(), nullable=False),
        sa.Column("token_hash", sa.Text(), nullable=False),
        sa.Column("created_at", sa.Text(), nullable=False),
        sa.CheckConstraint(
            "length(trim(token_hash)) > 0", name="ck_tokens_token_hash_nonempty"
        ),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"]),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("token_hash"),
    )
    op.create_table(
        "records",
        sa.Column("id", sa.Text(), nullable=False),
        sa.Column("client_id", sa.Text(), nullable=True),
        sa.Column("schema_version", sa.Integer(), nullable=False),
        sa.Column("artifact_kind", sa.Text(), nullable=False),
        sa.Column("artifact_id", sa.Text(), nullable=True),
        sa.Column("artifact_version", sa.Text(), nullable=True),
        sa.Column("artifact_repo", sa.Text(), nullable=True),
        sa.Column("summary", sa.Text(), nullable=False),
        sa.Column("work_type", sa.Text(), nullable=True),
        sa.Column("evidence_excerpt", sa.Text(), nullable=True),
        sa.Column("timestamp", sa.Text(), nullable=True),
        sa.Column("severity", sa.Text(), nullable=True),
        sa.Column("confidence", sa.Text(), nullable=True),
        sa.Column("cluster_key", sa.Text(), nullable=True),
        sa.Column("client_plugin", sa.Text(), nullable=True),
        sa.Column("client_harness", sa.Text(), nullable=True),
        sa.Column("created_at", sa.Text(), nullable=False),
        sa.Column("user_id", sa.Integer(), nullable=False),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"]),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_table(
        "quarantine",
        sa.Column("id", sa.Text(), nullable=False),
        sa.Column("reason", sa.Text(), nullable=False),
        sa.Column("payload", sa.Text(), nullable=False),
        sa.Column("created_at", sa.Text(), nullable=False),
        sa.PrimaryKeyConstraint("id"),
    )


def downgrade() -> None:
    op.drop_table("quarantine")
    op.drop_table("records")
    op.drop_table("tokens")
    op.drop_table("users")
