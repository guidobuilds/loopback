"""FastAPI ingest app for the loopback service (MVP: append-only store).

Endpoints:
- GET  /healthz          -> 200, liveness.
- POST /feedback         -> the ingest path (auth -> validate -> re-redact ->
                            persist). Append-only: every valid record is STORED.
                            Accepts ANY valid per-user token.
- GET  /feedback         -> read-back of stored records ("review all feedback
                            received"). Requires a valid ADMIN token (403 if the
                            token is valid but not admin). Supports pagination
                            (?limit default 100, ?limit=0 = all, ?offset) and
                            exact-match filters (artifact, severity, confidence,
                            email) plus an inclusive received_from/received_to
                            range. Each record carries a server-added
                            ``submitterEmail`` (the authenticated submitter).

Auth model (per-user, hashed-at-rest tokens)
--------------------------------------------
A presented ``Authorization: Bearer <token>`` is sha256-hashed and looked up in
the ``tokens`` table (joined to ``users``). There is NO environment/shared token.
Any valid token may POST; only a token whose user has ``is_admin = 1`` may GET
/feedback. Tokens are minted out-of-band by the admin CLI (``issue_token.py``)
against the same DB_PATH.

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
import uuid
from datetime import datetime, timezone
from typing import List, Optional

from fastapi import Depends, FastAPI, Header, Request
from fastapi.responses import JSONResponse
from pydantic import ValidationError
from sqlalchemy import select
from sqlalchemy.orm import Session

from . import db as db_mod
from . import redact
from . import tokens as tokens_mod
from .models import FeedbackRecord, FeedbackResponse
from .orm import Quarantine, Record, User


def _now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


_DEFAULT_PAGE = 100  # default `limit` when the param is absent.
_SEVERITY_LEVELS = {"low", "medium", "high"}  # shared by severity + confidence.


def _parse_pagination(
    limit: Optional[str], offset: Optional[str]
) -> "tuple[Optional[int], int, Optional[str]]":
    """Parse/validate the ?limit & ?offset query params for the read-back paths.

    Returns ``(limit, offset, error)``. Semantics (Part B):
    - ``limit`` absent -> default ``_DEFAULT_PAGE`` (100). A param-less read now
      returns at most 100 records, not the whole corpus.
    - ``limit=0`` -> ``None`` (UNLIMITED — return ALL records). This is the
      explicit "give me everything" escape hatch (the CLI's ``--all``).
    - ``limit < 0`` or non-integer -> 400 error. There is NO upper cap anymore.
    - ``offset`` absent -> 0; ``offset < 0`` or non-integer -> 400 error.

    Any malformed value yields an ``error`` string that the caller surfaces as
    400 (NOT 422; 422 is reserved for redaction-quarantine).
    """
    parsed_limit: Optional[int] = _DEFAULT_PAGE
    if limit is not None:
        try:
            parsed_limit = int(limit)
        except (TypeError, ValueError):
            return None, 0, "limit must be an integer"
        if parsed_limit < 0:
            return None, 0, "limit must be >= 0"
        if parsed_limit == 0:
            parsed_limit = None  # 0 means unlimited (all records).

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


def _authenticate(session: Session, authorization: Optional[str]) -> Optional[dict]:
    """Resolve a presented bearer to its owning user's identity, or None.

    Fail closed: missing/malformed bearer or no matching row => None. On success
    returns ``{user_id, email, is_admin}`` (joined tokens -> users).
    """
    plaintext = _extract_bearer(authorization)
    if not plaintext:
        return None
    return db_mod.lookup_token(session, tokens_mod.hash_token(plaintext))


def _records_as_wire(
    session: Session,
    limit: Optional[int] = _DEFAULT_PAGE,
    offset: int = 0,
    filters: Optional[dict] = None,
) -> List[dict]:
    """Return stored records (oldest first), reconstructed in the wire record shape.

    The shape matches ``feedback-record.schema.json`` (plus the server-added
    ``serverId`` and ``submitterEmail`` fields, which live OUTSIDE the wire
    schema) so E2E can re-validate stored records after popping those two server
    fields. No client-supplied user identifier is carried.

    ``limit=None`` returns ALL records (the ``?limit=0`` escape hatch); a numeric
    ``limit``/``offset`` page at the SQL level. ``filters`` is an optional dict of
    already-validated, exact-match (or range) criteria combined with AND:
    ``artifact``, ``severity``, ``confidence``, ``email`` (joins ``users``),
    ``received_from``/``received_to`` (inclusive ``created_at`` range).
    """
    filters = filters or {}
    # Select the record AND its submitter email in one go (outer join so a record
    # always renders even if its user row is somehow absent; user_id is NOT NULL
    # so in practice the email is always present).
    stmt = (
        select(Record, User.email)
        .outerjoin(User, Record.user_id == User.id)
        .order_by(Record.created_at)
    )
    if filters.get("artifact") is not None:
        stmt = stmt.where(Record.artifact_id == filters["artifact"])
    if filters.get("severity") is not None:
        stmt = stmt.where(Record.severity == filters["severity"])
    if filters.get("confidence") is not None:
        stmt = stmt.where(Record.confidence == filters["confidence"])
    if filters.get("email") is not None:
        stmt = stmt.where(User.email == filters["email"])
    if filters.get("received_from") is not None:
        stmt = stmt.where(Record.created_at >= filters["received_from"])
    if filters.get("received_to") is not None:
        stmt = stmt.where(Record.created_at <= filters["received_to"])
    if offset:
        stmt = stmt.offset(offset)
    if limit is not None:
        stmt = stmt.limit(limit)
    rows = session.execute(stmt).all()
    out: List[dict] = []
    for r, submitter_email in rows:
        out.append({
            "id": r.client_id or r.id,
            "serverId": r.id,
            "submitterEmail": submitter_email,
            "schemaVersion": r.schema_version,
            "artifact": {
                k: v for k, v in {
                    "kind": r.artifact_kind,
                    "id": r.artifact_id,
                    "version": r.artifact_version,
                    "repo": r.artifact_repo,
                }.items() if v is not None
            },
            "summary": r.summary,
            **({"workType": r.work_type} if r.work_type else {}),
            **({"evidenceExcerpt": r.evidence_excerpt} if r.evidence_excerpt is not None else {}),
            **({"timestamp": r.timestamp} if r.timestamp else {}),
            **({"severity": r.severity} if r.severity else {}),
            **({"confidence": r.confidence} if r.confidence else {}),
            **({"clusterKey": r.cluster_key} if r.cluster_key else {}),
            **({"client": {
                k: v for k, v in {
                    "plugin": r.client_plugin,
                    "harness": r.client_harness,
                }.items() if v is not None
            }} if r.client_plugin else {}),
        })
    return out


def create_app(db_path: Optional[str] = None) -> FastAPI:
    db_path = db_path or os.environ.get("DB_PATH", "/tmp/loopback.db")

    # Dev/test bootstrap: ensure the schema exists via create_all. Production
    # runs Alembic migrations at startup (see Dockerfile) before this runs.
    engine = db_mod.init_db(db_path)
    session_factory = db_mod.make_session_factory(engine)

    app = FastAPI(title="loopback-svc", version="0.0.1")
    app.state.db_path = db_path
    app.state.engine = engine
    app.state.session_factory = session_factory

    def get_db():
        """Yield a per-request Session, always closed afterward."""
        session = session_factory()
        try:
            yield session
        finally:
            session.close()

    @app.get("/healthz")
    def healthz() -> dict:
        return {"status": "ok"}

    @app.post("/feedback")
    async def post_feedback(
        request: Request,
        authorization: Optional[str] = Header(default=None),
        session: Session = Depends(get_db),
    ) -> JSONResponse:
        # 1. Auth: any valid per-user token (admin or not) may submit.
        identity = _authenticate(session, authorization)
        if identity is None:
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
            session.merge(Quarantine(
                id=record.id,
                reason=",".join(reasons),
                payload=json.dumps(raw),
                created_at=_now(),
            ))
            session.commit()
            return JSONResponse(
                status_code=422,
                content={"detail": "redaction re-check failed; quarantined", "patterns": reasons},
            )

        # 4. Accept: assign a server id and append the record to the store. The
        #    record is linked to the authenticated submitter via user_id.
        server_id = "fb_srv_" + uuid.uuid4().hex
        art = record.artifact
        session.add(Record(
            id=server_id,
            client_id=record.id,
            schema_version=record.schemaVersion,
            artifact_kind=art.kind.value,
            artifact_id=art.id,
            artifact_version=art.version,
            artifact_repo=art.repo,
            summary=record.summary,
            work_type=record.workType,
            evidence_excerpt=record.evidenceExcerpt,
            timestamp=record.timestamp,
            severity=record.severity.value if record.severity else None,
            confidence=record.confidence.value if record.confidence else None,
            cluster_key=record.clusterKey,
            client_plugin=record.client.plugin if record.client else None,
            client_harness=record.client.harness.value if record.client and record.client.harness else None,
            created_at=_now(),
            user_id=identity["user_id"],
        ))
        session.commit()

        resp = FeedbackResponse(status="stored", id=server_id)
        return JSONResponse(status_code=200, content=resp.model_dump())

    @app.get("/feedback")
    def list_feedback(
        authorization: Optional[str] = Header(default=None),
        limit: Optional[str] = None,
        offset: Optional[str] = None,
        artifact: Optional[str] = None,
        severity: Optional[str] = None,
        confidence: Optional[str] = None,
        email: Optional[str] = None,
        received_from: Optional[str] = None,
        received_to: Optional[str] = None,
        session: Session = Depends(get_db),
    ) -> JSONResponse:
        # First-class read-back: "review all feedback received". Reading the whole
        # corpus is an ADMIN action: a valid token is required (else 401) AND it
        # must be admin (else 403 — authenticated but not authorized).
        #
        # Pagination: param-less => first 100 (default); ?limit=0 => all; bad
        # limit/offset => 400. Filters (all optional, exact match unless noted,
        # combined with AND): artifact, severity, confidence, email (the user
        # filter, joins users), received_from/received_to (inclusive created_at
        # range). Order is created_at (oldest-first).
        identity = _authenticate(session, authorization)
        if identity is None:
            return JSONResponse(status_code=401, content={"detail": "unauthorized"})
        if not identity["is_admin"]:
            return JSONResponse(status_code=403, content={"detail": "forbidden"})
        lim, off, err = _parse_pagination(limit, offset)
        if err:
            return JSONResponse(status_code=400, content={"detail": err})
        # Validate the enum filters before querying (bad value -> 400, not silent).
        if severity is not None and severity not in _SEVERITY_LEVELS:
            return JSONResponse(
                status_code=400,
                content={"detail": "severity must be one of low|medium|high"},
            )
        if confidence is not None and confidence not in _SEVERITY_LEVELS:
            return JSONResponse(
                status_code=400,
                content={"detail": "confidence must be one of low|medium|high"},
            )
        filters = {
            "artifact": artifact,
            "severity": severity,
            "confidence": confidence,
            "email": email,
            "received_from": received_from,
            "received_to": received_to,
        }
        return JSONResponse(
            status_code=200,
            content=_records_as_wire(session, lim, off, filters),
        )

    return app


# Module-level app for `uvicorn app.main:app`.
app = create_app()
