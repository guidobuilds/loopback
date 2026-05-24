#!/usr/bin/env python3
"""Read-only CLI: print the latest stored feedback records.

A tiny operator/debugging utility for the loopback service's
append-only SQLite store. It does a single SELECT against the ``records``
table and prints the newest-first listing. It NEVER writes/alters the DB.

Stdlib only (no FastAPI / no venv needed):

    python3 show_latest_feedback.py            # latest 10 from the default DB
    python3 show_latest_feedback.py --limit 2  # latest 2
    DB_PATH=/path/to.db python3 show_latest_feedback.py
    python3 show_latest_feedback.py --db /path/to.db

The DB path resolution matches the service app (``app/main.py``): the
``DB_PATH`` env var, defaulting to ``/tmp/loopback.db`` locally.
Records are ordered by ``created_at`` (the server receive time, ISO 8601,
NOT NULL) DESC, with ``rowid`` DESC as a tiebreaker / fallback so insertion
order still wins when ``created_at`` values collide.
"""
from __future__ import annotations

import argparse
import os
import sqlite3
import sys
import textwrap

# Matches app/main.py: os.environ.get("DB_PATH", "/tmp/loopback.db").
DEFAULT_DB_PATH = "/tmp/loopback.db"
DEFAULT_LIMIT = 10

# The columns we surface, in display order. Kept faithful to schema.sql.
_SUMMARY_WIDTH = 76  # wrap width for the summary / evidence body text.


def _resolve_db_path(arg_db: str | None) -> str:
    """--db beats DB_PATH beats the app's built-in default."""
    if arg_db:
        return arg_db
    return os.environ.get("DB_PATH", DEFAULT_DB_PATH)


def _short(value: str | None, width: int) -> str:
    """Single-line truncation with an ellipsis (for compact inline fields)."""
    if value is None:
        return "-"
    value = " ".join(str(value).split())  # collapse internal whitespace
    if len(value) <= width:
        return value
    return value[: width - 1] + "…"


def _wrap_block(label: str, value: str | None, max_chars: int) -> list[str]:
    """Wrap a longer free-text field under an indented label; truncate if huge."""
    if value is None or value == "":
        return [f"  {label}: -"]
    value = value.strip()
    if len(value) > max_chars:
        value = value[: max_chars - 1] + "…"
    wrapped = textwrap.wrap(value, width=_SUMMARY_WIDTH) or ["-"]
    lines = [f"  {label}: {wrapped[0]}"]
    pad = " " * (len(label) + 4)
    for cont in wrapped[1:]:
        lines.append(pad + cont)
    return lines


def _fetch_latest(con: sqlite3.Connection, limit: int) -> list[sqlite3.Row]:
    """SELECT the newest `limit` records. Read-only (SELECT only)."""
    # created_at is NOT NULL (server receive time); rowid DESC breaks ties and
    # is the natural fallback for "latest" if created_at ever lacked ordering.
    sql = (
        "SELECT rowid AS _rowid, id, client_id, schema_version, artifact_kind, "
        "artifact_id, artifact_version, artifact_repo, summary, work_type, "
        "evidence_excerpt, timestamp, anon_user_id, severity, confidence, "
        "cluster_key, client_plugin, created_at "
        "FROM records ORDER BY created_at DESC, rowid DESC LIMIT ?"
    )
    return con.execute(sql, (limit,)).fetchall()


def _format_record(index: int, r: sqlite3.Row) -> str:
    """Render one record as a compact, scannable block."""
    out: list[str] = []
    out.append(f"#{index}  {r['id']}")
    out.append(f"  received : {r['created_at'] or '-'}    client-ts: {r['timestamp'] or '-'}")

    artifact = r["artifact_kind"] or "-"
    if r["artifact_id"]:
        artifact += f"/{r['artifact_id']}"
    if r["artifact_version"]:
        artifact += f"@{r['artifact_version']}"
    out.append(f"  artifact : {artifact}")

    meta = (
        f"  workType : {r['work_type'] or '-'}    "
        f"severity: {r['severity'] or '-'}    "
        f"confidence: {r['confidence'] or '-'}"
    )
    out.append(meta)

    out.append(
        f"  user     : {_short(r['anon_user_id'], 40)}    "
        f"plugin: {_short(r['client_plugin'], 28)}"
    )

    out.extend(_wrap_block("summary ", r["summary"], max_chars=400))
    if r["evidence_excerpt"]:
        out.extend(_wrap_block("evidence", r["evidence_excerpt"], max_chars=240))

    return "\n".join(out)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="show_latest_feedback.py",
        description="Print the latest stored feedback records (read-only).",
    )
    parser.add_argument(
        "--db",
        metavar="PATH",
        default=None,
        help="SQLite DB path (overrides $DB_PATH; default %s)" % DEFAULT_DB_PATH,
    )
    parser.add_argument(
        "--limit",
        type=int,
        default=DEFAULT_LIMIT,
        metavar="N",
        help="how many recent records to show (default %d)" % DEFAULT_LIMIT,
    )
    args = parser.parse_args(argv)

    if args.limit < 1:
        print("error: --limit must be >= 1", file=sys.stderr)
        return 2

    db_path = _resolve_db_path(args.db)

    if not os.path.exists(db_path):
        print(f"No database found at: {db_path}")
        print("Nothing to show yet. Set DB_PATH or pass --db to point at the store,")
        print("or submit feedback first so the service creates it.")
        return 0  # absence is a friendly state, not an error.

    # Open strictly read-only via a file: URI so we cannot mutate the store.
    uri = "file:" + os.path.abspath(db_path) + "?mode=ro"
    try:
        con = sqlite3.connect(uri, uri=True)
    except sqlite3.OperationalError as exc:
        print(f"error: could not open database '{db_path}': {exc}", file=sys.stderr)
        return 1
    con.row_factory = sqlite3.Row

    try:
        # Confirm the `records` table exists before querying it.
        exists = con.execute(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name='records'"
        ).fetchone()
        if not exists:
            print(f"Database '{db_path}' has no 'records' table "
                  "(is this a loopback store?).")
            return 0

        rows = _fetch_latest(con, args.limit)
    except sqlite3.DatabaseError as exc:
        print(f"error: reading database '{db_path}': {exc}", file=sys.stderr)
        return 1
    finally:
        con.close()

    if not rows:
        print(f"No feedback records stored yet in: {db_path}")
        return 0

    shown = len(rows)
    header = f"Latest {shown} feedback record(s) from {db_path}"
    if shown < args.limit:
        header += f"  (fewer than the requested {args.limit})"
    print(header)
    print("=" * min(len(header), 80))
    for i, row in enumerate(rows, start=1):
        print()
        print(_format_record(i, row))
    print()
    print("-" * 60)
    print(f"({shown} shown; newest first. read-only — the store was not modified.)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
