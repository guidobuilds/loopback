"""FastAPI ingest app for the loopback service (MVP: append-only store).

Endpoints:
- GET  /healthz          -> 200, liveness.
- POST /feedback         -> the ingest path (auth -> validate -> re-redact ->
                            persist). Append-only: every valid record is STORED.
                            Accepts ANY valid per-user token.
- GET  /feedback         -> read-back of ALL stored records ("review all feedback
                            received"). Requires a valid ADMIN token (403 if the
                            token is valid but not admin).

Auth model (per-user, hashed-at-rest tokens)
--------------------------------------------
A presented ``Authorization: Bearer <token>`` is sha256-hashed and looked up in
the ``tokens`` table. There is NO environment/shared token. Any valid token may
POST; only a token with ``is_admin = 1`` may GET /feedback. Tokens are minted
out-of-band by the admin CLI (``issue_token.py``) against the same DB_PATH.

HTTP status contract (design §7 split — strictly honored):
- 401  missing/malformed/unknown bearer token.
- 403  valid token but not authorized (e.g. non-admin calling GET /feedback).
- 400  schema-invalid body. NOTE: FastAPI/pydantic default to 422 for body
       validation; we normalize that to 400 here because 422 is RESERVED for the
       redaction-quarantine case below.
- 422  PII/secret patterns remain in summary/evidenceExcerpt -> QUARANTINE (the
       record is NOT written to the main `records` table).
- 200  accepted/stored: server assigns `id`, persists, returns {id, status}.

MVP scope (decided 2026-05-23)
------------------------------
The service is an APPEND-ONLY feedback store: it STORES every valid feedback
record with its identifying data. There is no registry, owner resolution,
dedup/clustering, or issue fan-out — a read-back endpoint lists all stored
feedback for later (human/automated) review.
"""
from __future__ import annotations

import json
import os
import sqlite3
import uuid
from datetime import datetime, timezone
from typing import List, Optional

from fastapi import FastAPI, Header, Request
from fastapi.responses import JSONResponse
from pydantic import ValidationError

from . import db as db_mod
from . import redact
from . import tokens as tokens_mod
from .models import FeedbackRecord, FeedbackResponse


def _now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


_MAX_PAGE = 500  # hard cap on `limit` so a single read can't pull the whole store.


def _parse_pagination(
    limit: Optional[str], offset: Optional[str]
) -> "tuple[Optional[int], int, Optional[str]]":
    """Parse/validate the ?limit & ?offset query params for the read-back paths.

    Returns ``(limit, offset, error)``. ``limit=None`` means "no limit" so the
    default (param-less) call still returns ALL records — the documented "review
    all feedback received" behavior — making pagination strictly opt-in and
    backward compatible. Any malformed value yields an ``error`` string that the
    caller surfaces as 400 (NOT 422; 422 is reserved for redaction-quarantine).
    """
    parsed_limit: Optional[int] = None
    if limit is not None:
        try:
            parsed_limit = int(limit)
        except (TypeError, ValueError):
            return None, 0, "limit must be an integer"
        if parsed_limit < 1:
            return None, 0, "limit must be >= 1"
        parsed_limit = min(parsed_limit, _MAX_PAGE)  # clamp, don't error.

    parsed_offset = 0
    if offset is not None:
        try:
            parsed_offset = int(offset)
        except (TypeError, ValueError):
            return None, 0, "offset must be an integer"
        if parsed_offset < 0:
            return None, 0, "offset must be >= 0"

    return parsed_limit, parsed_offset, None


def _extract_bearer(authorization: Optional[str]) -> Optional[str]:
    """Parse ``Authorization: Bearer <token>``; return the plaintext or None."""
    if not authorization:
        return None
    parts = authorization.split(None, 1)
    if len(parts) != 2 or parts[0].lower() != "bearer":
        return None
    return parts[1]


def _authenticate(
    con: sqlite3.Connection, authorization: Optional[str]
) -> Optional[dict]:
    """Resolve a presented bearer to its token row, or None.

    Fail closed: missing/malformed bearer or no matching row => None. On success
    returns ``{email, is_admin}`` from the ``tokens`` table.
    """
    plaintext = _extract_bearer(authorization)
    if not plaintext:
        return None
    return db_mod.lookup_token(con, tokens_mod.hash_token(plaintext))


def _records_as_wire(
    con: sqlite3.Connection,
    limit: Optional[int] = None,
    offset: int = 0,
) -> List[dict]:
    """Return stored records (oldest first), reconstructed in the wire record shape.

    The shape matches ``feedback-record.schema.json`` (plus a ``serverId``
    field) so E2E can re-validate stored records against the canonical schema.

    With the defaults (``limit=None, offset=0``) this returns ALL records, so
    param-less callers are unchanged. ``limit``/``offset`` page at the SQL level.
    """
    sql = "SELECT * FROM records ORDER BY created_at"
    params: List[int] = []
    if limit is not None or offset:
        # SQLite requires a LIMIT clause to honor OFFSET; -1 means "no limit".
        sql += " LIMIT ? OFFSET ?"
        params.extend([limit if limit is not None else -1, offset])
    rows = con.execute(sql, params).fetchall()
    out: List[dict] = []
    for r in rows:
        out.append({
            "id": r["client_id"] or r["id"],
            "serverId": r["id"],
            "schemaVersion": r["schema_version"],
            "artifact": {
                k: v for k, v in {
                    "kind": r["artifact_kind"],
                    "id": r["artifact_id"],
                    "version": r["artifact_version"],
                    "repo": r["artifact_repo"],
                }.items() if v is not None
            },
            "summary": r["summary"],
            **({"workType": r["work_type"]} if r["work_type"] else {}),
            **({"evidenceExcerpt": r["evidence_excerpt"]} if r["evidence_excerpt"] is not None else {}),
            **({"timestamp": r["timestamp"]} if r["timestamp"] else {}),
            **({"anonUserId": r["anon_user_id"]} if r["anon_user_id"] else {}),
            **({"severity": r["severity"]} if r["severity"] else {}),
            **({"confidence": r["confidence"]} if r["confidence"] else {}),
            **({"clusterKey": r["cluster_key"]} if r["cluster_key"] else {}),
            **({"client": {
                k: v for k, v in {
                    "plugin": r["client_plugin"],
                    "harness": r["client_harness"],
                }.items() if v is not None
            }} if r["client_plugin"] else {}),
        })
    return out


def create_app(db_path: Optional[str] = None) -> FastAPI:
    db_path = db_path or os.environ.get("DB_PATH", "/tmp/loopback.db")

    db_mod.init_db(db_path)
    con = db_mod.connect(db_path)

    app = FastAPI(title="loopback-svc", version="0.0.1")
    app.state.db_path = db_path
    app.state.con = con

    @app.get("/healthz")
    def healthz() -> dict:
        return {"status": "ok"}

    @app.post("/feedback")
    async def post_feedback(
        request: Request,
        authorization: Optional[str] = Header(default=None),
    ) -> JSONResponse:
        # 1. Auth: any valid per-user token (admin or not) may submit.
        if _authenticate(con, authorization) is None:
            return JSONResponse(status_code=401, content={"detail": "unauthorized"})

        # 2. Parse + validate body. Schema-invalid -> 400 (NOT 422; 422 reserved).
        try:
            raw = await request.json()
        except Exception:
            return JSONResponse(status_code=400, content={"detail": "invalid JSON body"})
        try:
            record = FeedbackRecord.model_validate(raw)
        except ValidationError as exc:
            return JSONResponse(
                status_code=400,
                content={"detail": "schema validation failed", "errors": exc.errors(include_url=False)},
            )

        # 3. Server-side redaction re-check (design §7). Leak -> 422 + quarantine.
        reasons = redact.leak_reasons(record.summary, record.evidenceExcerpt)
        if reasons:
            con.execute(
                "INSERT OR REPLACE INTO quarantine (id, reason, payload, created_at) VALUES (?,?,?,?)",
                (record.id, ",".join(reasons), json.dumps(raw), _now()),
            )
            con.commit()
            return JSONResponse(
                status_code=422,
                content={"detail": "redaction re-check failed; quarantined", "patterns": reasons},
            )

        # 4. Accept: assign a server id and append the record to the store.
        server_id = "fb_srv_" + uuid.uuid4().hex
        art = record.artifact
        con.execute(
            """INSERT INTO records
               (id, client_id, schema_version, artifact_kind, artifact_id,
                artifact_version, artifact_repo, summary, work_type,
                evidence_excerpt, timestamp, anon_user_id, severity, confidence,
                cluster_key, client_plugin, client_harness, created_at)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
            (
                server_id, record.id, record.schemaVersion, art.kind.value,
                art.id, art.version, art.repo, record.summary, record.workType,
                record.evidenceExcerpt, record.timestamp, record.anonUserId,
                record.severity.value if record.severity else None,
                record.confidence.value if record.confidence else None,
                record.clusterKey,
                record.client.plugin if record.client else None,
                record.client.harness.value if record.client and record.client.harness else None,
                _now(),
            ),
        )
        con.commit()

        resp = FeedbackResponse(status="stored", id=server_id)
        return JSONResponse(status_code=200, content=resp.model_dump())

    @app.get("/feedback")
    def list_feedback(
        authorization: Optional[str] = Header(default=None),
        limit: Optional[str] = None,
        offset: Optional[str] = None,
    ) -> JSONResponse:
        # First-class read-back: "review all feedback received". Reading the whole
        # corpus is an ADMIN action: a valid token is required (else 401) AND it
        # must be admin (else 403 — authenticated but not authorized).
        # Pagination is opt-in via ?limit & ?offset; param-less => all records.
        identity = _authenticate(con, authorization)
        if identity is None:
            return JSONResponse(status_code=401, content={"detail": "unauthorized"})
        if not identity["is_admin"]:
            return JSONResponse(status_code=403, content={"detail": "forbidden"})
        lim, off, err = _parse_pagination(limit, offset)
        if err:
            return JSONResponse(status_code=400, content={"detail": err})
        return JSONResponse(status_code=200, content=_records_as_wire(con, lim, off))

    return app


# Module-level app for `uvicorn app.main:app`.
app = create_app()
