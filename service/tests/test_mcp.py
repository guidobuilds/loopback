"""Tests for the server-hosted MCP (app/mcp_server.py).

Two MCP-specific concerns the REST tests don't cover:
- ``BearerAuthMiddleware``: the ASGI gate that authenticates the bearer against
  the SAME tokens table and stashes ``user_id`` in a contextvar.
- the ``submit_feedback`` tool: it must assemble the wire record and honor the
  IDENTICAL ingest contract as ``POST /feedback`` (ok / quarantined / error),
  attributing the stored record to the authenticated user.

The shared ingest core itself is already covered by the REST suite (test_api.py),
since POST /feedback and the tool both call ``app.ingest.ingest_record``.
"""
from __future__ import annotations

import json
import os
import tempfile

import anyio
from sqlalchemy import select

from app import db as db_mod
from app import tokens as tokens_mod
from app.mcp_server import BearerAuthMiddleware, _current_user_id, build_mcp
from app.orm import Record


def _fresh_db_with_user():
    """Temp DB + one non-admin user/token; returns (session_factory, token, uid)."""
    tmp = tempfile.mkdtemp()
    engine = db_mod.init_db(os.path.join(tmp, "fb.db"))
    sf = db_mod.make_session_factory(engine)
    session = sf()
    try:
        plaintext = tokens_mod.generate_token()
        user = db_mod.get_or_create_user(
            session, "dev@example.com", is_admin=False, created_at="2026-05-29T00:00:00Z"
        )
        db_mod.insert_token(
            session, user, tokens_mod.hash_token(plaintext), "2026-05-29T00:00:00Z"
        )
        session.commit()
        return sf, plaintext, user.id
    finally:
        session.close()


def _call_tool(sf, uid, args):
    """Invoke submit_feedback with the auth contextvar set to ``uid``; return body."""
    mcp = build_mcp(sf)

    async def run():
        cv = _current_user_id.set(uid)
        try:
            res = await mcp.call_tool("submit_feedback", args)
        finally:
            _current_user_id.reset(cv)
        return json.loads(res[0].text)

    return anyio.run(run)


def test_tool_stores_clean_record_attributed_to_user():
    sf, _tok, uid = _fresh_db_with_user()
    body = _call_tool(sf, uid, {
        "artifactKind": "skill",
        "artifactId": "prd-writer",
        "summary": "Skill used the wrong template; it should use the PRD v2 template.",
        "severity": "high",
        "confidence": "medium",
        "harness": "claude-code",
    })
    assert body["status"] == "ok"
    assert body["id"].startswith("fb_")

    session = sf()
    try:
        rec = session.execute(
            select(Record).where(Record.id == body["id"])
        ).scalar_one()
        assert rec.user_id == uid                 # attributed to the bearer's user
        assert rec.artifact_id == "prd-writer"
        assert rec.severity == "high"
        assert rec.client_plugin.startswith("loopback-mcp@")
        assert rec.client_harness == "claude-code"
    finally:
        session.close()


def test_tool_quarantines_leak_and_returns_patterns():
    sf, _tok, uid = _fresh_db_with_user()
    body = _call_tool(sf, uid, {
        "artifactKind": "skill",
        "artifactId": "prd-writer",
        "summary": "reach me at john@example.com to discuss",
    })
    assert body["status"] == "quarantined"
    assert "email" in body["patterns"]
    # nothing persisted to the main store
    session = sf()
    try:
        assert session.execute(select(Record)).first() is None
    finally:
        session.close()


def test_tool_schema_invalid_returns_error():
    sf, _tok, uid = _fresh_db_with_user()
    body = _call_tool(sf, uid, {
        "artifactKind": "not-a-kind",  # not in the schema enum -> 400 -> error
        "artifactId": "x",
        "summary": "y",
    })
    assert body["status"] == "error"


def test_tool_drops_unknown_harness_rather_than_failing():
    sf, _tok, uid = _fresh_db_with_user()
    body = _call_tool(sf, uid, {
        "artifactKind": "skill",
        "artifactId": "prd-writer",
        "summary": "A clean, generalizable lesson with no PII.",
        "harness": "vim",  # not a known harness -> dropped, NOT a 400
    })
    assert body["status"] == "ok"
    session = sf()
    try:
        rec = session.execute(
            select(Record).where(Record.id == body["id"])
        ).scalar_one()
        assert rec.client_harness is None
    finally:
        session.close()


# ---- BearerAuthMiddleware (pure ASGI) -------------------------------------- #


def _run_middleware(sf, headers):
    """Drive BearerAuthMiddleware with a fake HTTP scope; return (sent, seen_uid)."""
    seen = {}

    async def inner_app(scope, receive, send):
        seen["uid"] = _current_user_id.get()
        await send({"type": "http.response.start", "status": 200, "headers": []})
        await send({"type": "http.response.body", "body": b"ok"})

    mw = BearerAuthMiddleware(inner_app, sf)
    sent = []

    async def run():
        async def receive():
            return {"type": "http.request", "body": b"", "more_body": False}

        async def send(msg):
            sent.append(msg)

        await mw({"type": "http", "headers": headers}, receive, send)

    anyio.run(run)
    return sent, seen.get("uid")


def test_middleware_rejects_missing_token():
    sf, _tok, _uid = _fresh_db_with_user()
    sent, seen_uid = _run_middleware(sf, [])
    assert sent[0]["status"] == 401
    assert seen_uid is None  # inner app never ran


def test_middleware_rejects_bad_token():
    sf, _tok, _uid = _fresh_db_with_user()
    sent, _ = _run_middleware(sf, [(b"authorization", b"Bearer bogus")])
    assert sent[0]["status"] == 401


def test_middleware_passes_valid_token_and_sets_identity():
    sf, plaintext, uid = _fresh_db_with_user()
    sent, seen_uid = _run_middleware(
        sf, [(b"authorization", b"Bearer " + plaintext.encode())]
    )
    assert sent[0]["status"] == 200
    assert seen_uid == uid  # contextvar visible to the downstream tool
