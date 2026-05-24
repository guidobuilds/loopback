"""B6: pydantic <-> canonical JSON Schema lockstep.

Proves the service's pydantic model and the canonical JSON Schema agree:
- the VALID fixture is accepted by BOTH pydantic AND Draft202012Validator.
- the MISSING-SUMMARY fixture is rejected by BOTH.

Also asserts the service's copy of the wire contract is byte-for-byte (normalized)
identical to the plugin's canonical schema, so client-ajv and server-pydantic
cannot drift. Uses Python `jsonschema` `Draft202012Validator` (NOT ajv-cli@5,
which cannot validate draft 2020-12).
"""
from __future__ import annotations

import json
import os
from pathlib import Path

import pytest
from jsonschema import Draft202012Validator
from pydantic import ValidationError

from app.models import FeedbackRecord

SVC_ROOT = Path(__file__).resolve().parent.parent
SVC_SCHEMA = SVC_ROOT / "feedback-record.schema.json"
FIXTURES = Path(__file__).parent / "fixtures"

# The plugin's canonical schema. Default to the known repo path but allow override.
PLUGIN_DIR = Path(
    os.environ.get(
        "PLUGIN_DIR",
        str(SVC_ROOT.parent / "loopback"),
    )
)
PLUGIN_SCHEMA = PLUGIN_DIR / "core" / "feedback-record.schema.json"


def _load(p: Path) -> dict:
    return json.loads(p.read_text(encoding="utf-8"))


def test_service_schema_is_valid_draft_2020_12():
    schema = _load(SVC_SCHEMA)
    Draft202012Validator.check_schema(schema)  # raises if not a valid 2020-12 schema


def test_valid_fixture_accepted_by_both():
    schema = _load(SVC_SCHEMA)
    valid = _load(FIXTURES / "record.valid.json")

    # JSON Schema accepts it.
    errors = list(Draft202012Validator(schema).iter_errors(valid))
    assert errors == [], errors

    # pydantic accepts it.
    FeedbackRecord.model_validate(valid)  # raises on failure


def test_missing_summary_rejected_by_both():
    schema = _load(SVC_SCHEMA)
    missing = _load(FIXTURES / "record.missing-summary.json")

    # JSON Schema rejects it (missing required summary).
    errors = list(Draft202012Validator(schema).iter_errors(missing))
    assert errors, "schema should reject missing summary"
    assert any("summary" in e.message for e in errors), [e.message for e in errors]

    # pydantic rejects it.
    with pytest.raises(ValidationError):
        FeedbackRecord.model_validate(missing)


def test_client_harness_accepted_by_both():
    """The harness-agnostic addition: client.harness is in lockstep (both accept)."""
    schema = _load(SVC_SCHEMA)
    valid = _load(FIXTURES / "record.valid.json")
    valid = {**valid, "client": {"plugin": "loopback@0.0.1", "harness": "opencode"}}

    errors = list(Draft202012Validator(schema).iter_errors(valid))
    assert errors == [], errors
    FeedbackRecord.model_validate(valid)  # raises on failure

    # And an unknown harness value is rejected by both.
    bad = {**valid, "client": {"plugin": "loopback@0.0.1", "harness": "cursor"}}
    assert list(Draft202012Validator(schema).iter_errors(bad)), "unknown harness must be rejected"
    with pytest.raises(ValidationError):
        FeedbackRecord.model_validate(bad)


def test_service_schema_matches_plugin_canonical():
    if not PLUGIN_SCHEMA.exists():
        pytest.skip(f"plugin canonical schema not found at {PLUGIN_SCHEMA}")
    # Normalized (parsed) comparison so whitespace/key-order can't cause false drift.
    assert _load(SVC_SCHEMA) == _load(PLUGIN_SCHEMA), (
        "service schema has drifted from the plugin canonical wire contract"
    )
