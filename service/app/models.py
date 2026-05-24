"""Pydantic models for the feedback record wire contract.

These models conform to ``feedback-record.schema.json`` (the single source-of-
truth wire contract, design §5). The lockstep test (tests/test_contract.py)
proves that pydantic and the JSON Schema agree on accept/reject for the shared
fixtures, so the client (ajv) and server (pydantic) cannot drift.

Key conformance choices to match the schema's ``additionalProperties: false``:
- every model sets ``model_config = ConfigDict(extra="forbid")``.
- enums mirror the schema enums exactly.
- ``schemaVersion`` is pinned to the const ``1``.
"""
from __future__ import annotations

from enum import Enum
from typing import Optional

from pydantic import BaseModel, ConfigDict, Field, field_validator


class ArtifactKind(str, Enum):
    skill = "skill"
    agent = "agent"
    artifact = "artifact"


class Severity(str, Enum):
    low = "low"
    medium = "medium"
    high = "high"


class Confidence(str, Enum):
    low = "low"
    medium = "medium"
    high = "high"


class Harness(str, Enum):
    claude_code = "claude-code"
    opencode = "opencode"
    codex = "codex"


class Artifact(BaseModel):
    model_config = ConfigDict(extra="forbid")

    kind: ArtifactKind
    id: Optional[str] = Field(default=None, min_length=1)
    version: Optional[str] = Field(default=None, min_length=1)
    repo: Optional[str] = Field(default=None, min_length=1)


class Client(BaseModel):
    model_config = ConfigDict(extra="forbid")

    plugin: str = Field(min_length=1)
    harness: Optional[Harness] = None


class FeedbackRecord(BaseModel):
    """A feedback record exactly as it crosses the wire (design §5)."""

    model_config = ConfigDict(extra="forbid")

    id: str = Field(min_length=1, description="Client-supplied record id.")
    schemaVersion: int
    artifact: Artifact
    summary: str = Field(min_length=1)
    workType: Optional[str] = Field(default=None, min_length=1)
    evidenceExcerpt: Optional[str] = None
    timestamp: Optional[str] = None
    anonUserId: Optional[str] = Field(default=None, min_length=1)
    severity: Optional[Severity] = None
    confidence: Optional[Confidence] = None
    clusterKey: Optional[str] = Field(default=None, min_length=1)
    client: Optional[Client] = None

    @field_validator("schemaVersion")
    @classmethod
    def _schema_version_const(cls, v: int) -> int:
        # Mirror the JSON Schema `const: 1`.
        if v != 1:
            raise ValueError("schemaVersion must be 1")
        return v


class FeedbackResponse(BaseModel):
    """The accept response for the append-only store: server id + status.

    The MVP just stores the record, so the response is ``{id, status: "stored"}``
    (no issue/cluster fields — routing was removed)."""

    model_config = ConfigDict(extra="forbid")

    status: str = "stored"
    id: str
