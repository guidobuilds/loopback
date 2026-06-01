# MCP reference

The loopback MCP server is the **universal interface**: the portable
`feedback-detector` skill / `/harness-feedback` command drive the flow by calling
it identically under Claude Code, OpenCode, and Codex.

As of the server-side migration the MCP is **hosted by the loopback service**
(remote MCP over HTTP) rather than installed as a local stdio bundle. Behaviour
updates ship with the service — clients never re-install to pick up MCP changes.

- **Transport:** Streamable HTTP (stateless, JSON responses), mounted at
  `<service-url>/mcp`. Source: `service/app/mcp_server.py`, mounted by
  `service/app/main.py`.
- **Auth:** a static `Authorization: Bearer <token>` header on every request,
  validated against the same per-user `tokens` table as the REST API (a small
  ASGI middleware resolves the token to a user; there is no OAuth flow). A
  missing/invalid token → `401`.
- **Tool surface:** a **single** tool, `submit_feedback`. Redaction is now done by
  the skill in-context (the service re-checks as a quarantine safety net); the
  former `redact_preview`, `is_muted`, `mute_artifact`, `get_session_state`, and
  `record_signal` tools were removed.

## Registration

`@guidobuilds/loopback-setup` registers the remote endpoint per harness, writing
the service URL (`<base>/mcp`) + the bearer header. The shapes it writes:

**Claude Code** (`claude mcp add-json loopback … -s user`):

```json
{ "type": "http", "url": "<base>/mcp",
  "headers": { "Authorization": "Bearer <token>" } }
```

**OpenCode** (`mcp.loopback` in `opencode.json(c)`):

```json
{ "type": "remote", "url": "<base>/mcp", "enabled": true,
  "headers": { "Authorization": "Bearer <token>" } }
```

**Codex** (`~/.codex/config.toml`):

```toml
[mcp_servers.loopback]
url = "<base>/mcp"
http_headers = { "Authorization" = "Bearer <token>" }
```

The token is written into each harness's MCP config by the installer (the remote
server reads it from the request header). `~/.loopback/config.json` stays the
installer's single source of truth for the URL + token; rotate by re-running the
installer. Any env/header entries the user added by hand under the loopback entry
are preserved across re-runs (OpenCode / Codex).

> **OpenCode note:** OpenCode connects to remote MCP servers via its
> `type: "remote"` entry; some versions only speak the legacy SSE transport. If
> your OpenCode cannot reach the Streamable-HTTP endpoint, also expose the
> service's SSE app (see `service/app/mcp_server.py`). Verify against your version.

## Tool

### `submit_feedback`

The terminal call after the user chose `[S]end` at the consent gate. The skill
passes the artifact fields plus the **already-redacted** `summary` /
`evidenceExcerpt`; the server assembles the wire record, re-checks redaction
(quarantine on leak), stamps `client.{plugin,harness}`, and persists it (linked to
the authenticated submitter).

| Input | Type | Required | Notes |
|-------|------|----------|-------|
| `artifactKind` | `skill\|agent\|artifact` | yes | Kind of artifact. |
| `artifactId` | string | yes | e.g. `prd-writer`. |
| `artifactVersion` | string | no | e.g. `3.2.0`. |
| `artifactRepo` | string | no | Repo the user was working in. |
| `summary` | string | yes | The synthesized, de-identified, **redacted** lesson. |
| `workType` | string | no | Task category, e.g. `prd-authoring`. |
| `evidenceExcerpt` | string | no | Minimal, **already-redacted** excerpt the user approved. |
| `severity` | `low\|medium\|high` | no | Defect severity. |
| `confidence` | `low\|medium\|high` | no | Detector self-rating. |
| `clusterKey` | string | no | Proposed dedup key, e.g. `artifact:workType:problem`. |
| `harness` | `claude-code\|opencode\|codex` | no | The calling harness (stamped as `client.harness`; a value outside this set is dropped). |

Output (JSON):

- `{"status":"ok","id":"fb_…"}` — stored.
- `{"status":"quarantined","patterns":[…]}` — the redaction safety net still found
  PII/secret patterns; re-redact those and retry once.
- `{"status":"error","error":…}` — schema or other failure; nothing was stored.

---

See also: [install.md](install.md) · [admin.md](admin.md) ·
[environment-variables.md](environment-variables.md) · [service.md](service.md) ·
[`../DEVELOPMENT.md`](../DEVELOPMENT.md).
