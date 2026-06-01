"""Shared ingest core: validate -> redaction re-check (quarantine) -> persist.

Extracted from the original ``post_feedback`` handler so BOTH entry points share
exactly one contract and cannot drift:

- the REST route ``POST /feedback`` (``app/main.py``), and
- the MCP tool ``submit_feedback`` (``app/mcp_server.py``).

The function is transport-agnostic: it takes an already-parsed ``raw`` wire dict
and the authenticated ``user_id``, and returns ``(http_status, body)``. The
caller maps that to its own surface (a JSONResponse for REST, a result dict for
the MCP tool). The HTTP status contract (design §7) is honored verbatim:

- 400  schema-invalid body.
- 422  PII/secret patterns remain in summary/evidenceExcerpt -> QUARANTINE (the
       record is NOT written to the ``records`` table).
- 200  accepted/stored: server assigns ``id`` (``fb_<uuid>``), persists.
"""
from __future__ import annotations

import json
import uuid
from datetime import datetime, timezone
from typing import Tuple

from pydantic import ValidationError
from sqlalchemy.orm import Session

from . import redact
from .models import FeedbackRecord
from .orm import Quarantine, Record


def now_iso() -> str:
    """Server receive timestamp, second-resolution UTC (``...Z``)."""
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def ingest_record(session: Session, raw: dict, user_id: int) -> "Tuple[int, dict]":
    """Validate, server-side redaction re-check, then persist one wire record.

    ``raw`` is the wire record shape (``feedback-record.schema.json``); ``user_id``
    is the authenticated submitter (resolved upstream from the bearer token). The
    server re-runs redaction detection as defense-in-depth: a record that still
    carries PII/secret patterns is QUARANTINED (422) and never written to the main
    store — the body carries ``patterns`` so the caller can re-redact and retry.
    """
    # 1. Schema validation. Schema-invalid -> 400 (NOT 422; 422 reserved).
    try:
        record = FeedbackRecord.model_validate(raw)
    except ValidationError as exc:
        return 400, {
            "detail": "schema validation failed",
            "errors": exc.errors(include_url=False),
        }

    # 2. Server-side redaction re-check (design §7). Leak -> 422 + quarantine.
    reasons = redact.leak_reasons(record.summary, record.evidenceExcerpt)
    if reasons:
        session.add(Quarantine(
            id="fb_" + uuid.uuid4().hex,
            reason=",".join(reasons),
            payload=json.dumps(raw),
            created_at=now_iso(),
        ))
        session.commit()
        return 422, {
            "detail": "redaction re-check failed; quarantined",
            "patterns": reasons,
        }

    # 3. Accept: assign a server id and append the record, linked to the submitter.
    server_id = "fb_" + uuid.uuid4().hex
    art = record.artifact
    session.add(Record(
        id=server_id,
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
        created_at=now_iso(),
        user_id=user_id,
    ))
    session.commit()
    return 200, {"status": "stored", "id": server_id}
