"""Server-hosted MCP for loopback (replaces the former client-side stdio server).

The loopback MCP now lives IN the service: clients (Claude Code / OpenCode /
Codex) register a REMOTE MCP endpoint (``<service>/mcp``) with a static
``Authorization: Bearer <token>`` header instead of running a local bundle. This
means MCP behaviour updates server-side with no client re-install.

Transport: **Streamable HTTP, stateless + JSON** (``stateless_http=True,
json_response=True``). Stateless is the right fit here — there is a single,
non-streaming tool and no per-connection server state — and it makes per-request
auth trivial: every request carries the bearer, a tiny ASGI middleware validates
it against the SAME token table the REST API uses, and stashes the resolved
``user_id`` in a contextvar the tool reads. We deliberately do NOT use FastMCP's
OAuth ``AuthSettings``: the three CLI clients send a static header, so a plain
401 on an invalid/missing token is the correct, OAuth-free contract.

Tool surface (decided 2026-05-29): a SINGLE tool, ``submit_feedback``. Redaction
moved to the skill (the server keeps ``redact.py`` only as the quarantine safety
net via :func:`app.ingest.ingest_record`); mutes and the session-debounce tools
were retired. The tool reuses ``ingest_record`` so it honors the identical
validate -> redaction re-check -> persist contract as ``POST /feedback``.
"""
from __future__ import annotations

import contextvars
from typing import Optional

from mcp.server.fastmcp import FastMCP
from starlette.types import ASGIApp, Receive, Scope, Send

from . import db as db_mod
from . import tokens as tokens_mod
from .ingest import ingest_record, now_iso

# Stamped into the wire record's client.plugin (telemetry; "name@version").
SERVER_PLUGIN_TAG = "loopback-mcp@0.2.0"
_HARNESSES = {"claude-code", "opencode", "codex"}

# Set by BearerAuthMiddleware on each authenticated request; read by the tool.
# Default None so an un-authenticated path (which the middleware blocks anyway)
# can never mis-attribute a record.
_current_user_id: contextvars.ContextVar[Optional[int]] = contextvars.ContextVar(
    "loopback_mcp_user_id", default=None
)


def _extract_bearer(headers: "list[tuple[bytes, bytes]]") -> Optional[str]:
    """Pull a ``Bearer <token>`` value from raw ASGI headers, or None."""
    for key, value in headers:
        if key.lower() == b"authorization":
            parts = value.decode("latin-1").split(None, 1)
            if len(parts) == 2 and parts[0].lower() == "bearer":
                return parts[1]
    return None


async def _send_401(send: Send) -> None:
    body = b'{"detail":"unauthorized"}'
    await send({
        "type": "http.response.start",
        "status": 401,
        "headers": [
            (b"content-type", b"application/json"),
            (b"www-authenticate", b"Bearer"),
        ],
    })
    await send({"type": "http.response.body", "body": body})


class BearerAuthMiddleware:
    """Pure-ASGI gate in front of the mounted MCP app.

    Requires a valid loopback bearer on every HTTP request (reusing
    ``tokens.hash_token`` + ``db.lookup_token`` — the exact same auth as the REST
    API), and stashes the resolved ``user_id`` in a contextvar for the tool. A
    missing/invalid token short-circuits to 401 without ever reaching the MCP
    app. Non-HTTP scopes (lifespan) pass straight through.
    """

    def __init__(self, app: ASGIApp, session_factory) -> None:
        self.app = app
        self.session_factory = session_factory

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        token = _extract_bearer(scope.get("headers", []))
        identity = None
        if token:
            session = self.session_factory()
            try:
                identity = db_mod.lookup_token(session, tokens_mod.hash_token(token))
            finally:
                session.close()

        if identity is None:
            await _send_401(send)
            return

        cv_token = _current_user_id.set(identity["user_id"])
        try:
            await self.app(scope, receive, send)
        finally:
            _current_user_id.reset(cv_token)


def build_mcp(session_factory) -> FastMCP:
    """Build the loopback FastMCP server (one tool: ``submit_feedback``).

    ``session_factory`` is the app's SQLAlchemy sessionmaker — shared so the tool
    writes to the same engine/DB as the REST routes. Returns the FastMCP instance;
    the caller mounts ``mcp.streamable_http_app()`` (wrapped in
    :class:`BearerAuthMiddleware`) and runs ``mcp.session_manager.run()`` in the
    host app's lifespan.
    """
    mcp = FastMCP("loopback", stateless_http=True, json_response=True)
    # Serve the endpoint at the mount root (clients hit ``<service>/mcp``, not
    # ``<service>/mcp/mcp``).
    mcp.settings.streamable_http_path = "/"

    @mcp.tool(
        name="submit_feedback",
        description=(
            "Submit ONE de-identified loopback record to the central feedback "
            "service. Call this ONLY after the user explicitly chose [S]end at the "
            "consent gate, and ONLY with summary/evidenceExcerpt the skill already "
            "redacted (show-exactly-what-is-sent). The server re-checks redaction; "
            "if anything leaked it returns status='quarantined' with the offending "
            "`patterns` so you can re-redact those and retry ONCE."
        ),
    )
    async def submit_feedback(
        artifactKind: str,
        artifactId: str,
        summary: str,
        artifactVersion: Optional[str] = None,
        artifactRepo: Optional[str] = None,
        workType: Optional[str] = None,
        evidenceExcerpt: Optional[str] = None,
        severity: Optional[str] = None,
        confidence: Optional[str] = None,
        clusterKey: Optional[str] = None,
        harness: Optional[str] = None,
    ) -> dict:
        user_id = _current_user_id.get()
        if user_id is None:
            # Should be unreachable behind BearerAuthMiddleware; fail closed.
            return {"status": "error", "error": "unauthenticated"}

        # Assemble the wire record (the job the client's wire.assembleRecord used
        # to do). Server stamps timestamp + client; the skill already redacted.
        artifact: dict = {"kind": artifactKind, "id": artifactId}
        if artifactVersion:
            artifact["version"] = artifactVersion
        if artifactRepo:
            artifact["repo"] = artifactRepo

        raw: dict = {"schemaVersion": 1, "artifact": artifact, "summary": summary}
        if workType:
            raw["workType"] = workType
        if evidenceExcerpt is not None:
            raw["evidenceExcerpt"] = evidenceExcerpt
        if severity:
            raw["severity"] = severity
        if confidence:
            raw["confidence"] = confidence
        if clusterKey:
            raw["clusterKey"] = clusterKey
        raw["timestamp"] = now_iso()
        client: dict = {"plugin": SERVER_PLUGIN_TAG}
        if harness in _HARNESSES:  # drop a stray value rather than 400 the record
            client["harness"] = harness
        raw["client"] = client

        session = session_factory()
        try:
            status, body = ingest_record(session, raw, user_id)
        finally:
            session.close()

        if status == 200:
            return {"status": "ok", "id": body["id"]}
        if status == 422:
            return {"status": "quarantined", "patterns": body.get("patterns", [])}
        return {
            "status": "error",
            "error": body.get("detail", "error"),
            "errors": body.get("errors"),
        }

    return mcp
