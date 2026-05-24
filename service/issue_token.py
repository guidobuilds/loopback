#!/usr/bin/env python3
"""Admin CLI: mint a per-user API token for the loopback service.

Generates a high-entropy ``lpbk_`` token, stores ONLY its sha256 hash as a NEW
row in the append-only ``tokens`` table, and prints the plaintext token ONCE
(it is not recoverable). Identity is normalized: a ``User`` is keyed by a unique ``email`` and carries
``is_admin``. Re-issuing for an existing email reuses the SAME user and appends a
NEW token row. ``--admin`` grants the user admin (read) access to GET /feedback;
on an existing non-admin user, ``--admin`` promotes them (idempotent).

This is the bootstrap path: the first admin is minted here (it writes directly
to the DB), so there is no chicken-and-egg with API auth.

Needs the service venv/container deps (SQLAlchemy), no longer stdlib-only:

    python3 issue_token.py --email dev@example.com
    python3 issue_token.py --email you@example.com --admin
    python3 issue_token.py --email dev@example.com --db /path/to/loopback.db
    DB_PATH=/path/to/loopback.db python3 issue_token.py --email dev@example.com
    # in docker (same DB_PATH as the running service):
    docker exec -it loopback-svc python3 issue_token.py --email dev@example.com

The DB path resolution matches the service app (``app/main.py``): the
``DB_PATH`` env var, defaulting to ``/tmp/loopback.db`` locally. The token's
sha256 hash is stored; the plaintext is NEVER persisted.
"""
from __future__ import annotations

import argparse
import os
import re
import sys
from datetime import datetime, timezone

# Shared persistence + token primitives. issue_token now uses the SQLAlchemy
# layer (ORM helpers) rather than raw sqlite3, so it requires the venv deps.
from app.db import get_or_create_user, init_db, insert_token, make_session_factory
from app.tokens import generate_token, hash_token

# Matches app/main.py: os.environ.get("DB_PATH", "/tmp/loopback.db").
DEFAULT_DB_PATH = "/tmp/loopback.db"

# Pragmatic stdlib email check: non-empty local part, single @, domain with at
# least one dot, no whitespace. Catches the obvious-bad cases (empty, missing @,
# missing domain/TLD, whitespace) — sufficient for an operator-run tool. The DB
# CHECK enforces non-empty as a backstop.
_EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")


def _resolve_db_path(arg_db: str | None) -> str:
    """--db beats DB_PATH beats the app's built-in default."""
    if arg_db:
        return arg_db
    return os.environ.get("DB_PATH", DEFAULT_DB_PATH)


def _now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="issue_token.py",
        description="Mint a per-user API token for the loopback service.",
    )
    parser.add_argument(
        "--email",
        required=True,
        metavar="ADDR",
        help="the developer/operator email this token is issued to (required)",
    )
    parser.add_argument(
        "--admin",
        action="store_true",
        help="grant admin (read) access to GET /feedback (default: non-admin)",
    )
    parser.add_argument(
        "--db",
        metavar="PATH",
        default=None,
        help="SQLite DB path (overrides $DB_PATH; default %s)" % DEFAULT_DB_PATH,
    )
    args = parser.parse_args(argv)

    email = args.email.strip()
    if not _EMAIL_RE.match(email):
        print(
            f"error: invalid email address: {args.email!r} "
            "(expected like name@example.com)",
            file=sys.stderr,
        )
        return 2

    db_path = _resolve_db_path(args.db)

    # Mint + hash; only the hash is ever stored.
    token = generate_token()
    token_hash = hash_token(token)
    created_at = _now()

    try:
        # Ensure the DB + schema exist (idempotent), then mint via the ORM:
        # get-or-create the user (promote to admin if --admin) and append a token.
        engine = init_db(db_path)
        session_factory = make_session_factory(engine)
        session = session_factory()
        try:
            user = get_or_create_user(
                session, email, is_admin=args.admin, created_at=created_at
            )
            insert_token(session, user, token_hash, created_at)
            session.commit()
        finally:
            session.close()
    except Exception as exc:  # noqa: BLE001 — surface any DB/ORM failure to the operator
        print(f"error: writing database '{db_path}': {exc}", file=sys.stderr)
        return 1

    # Print the plaintext ONCE. Never print the hash.
    print(f"Issued token for {email}")
    print(f"  token   : {token}   <-- shown ONCE; give it to the developer, it is NOT recoverable")
    print(f"  email   : {email}")
    print(f"  is_admin: {'yes' if args.admin else 'no'}")
    print(f"  created : {created_at}")
    print("Store it in LOOPBACK_TOKEN on the developer's machine (the plugin client reads that var).")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
