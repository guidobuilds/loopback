# Environment variables

loopback uses no `.env` files. Every variable below is read directly from the
process environment. Client credentials are normally persisted by `loopback
auth` to `~/.loopback/config.json` (so you rarely export them by hand); env
vars act as per-session overrides when set.

## Service

| Name | Required | Default | Controls | Read by |
|------|----------|---------|----------|---------|
| `DB_PATH` | no | `/tmp/loopback.db` locally, `/data/loopback.db` in the image | SQLite DB path for the service, `issue_token.py`, and Alembic. | `service/app/main.py`, `service/issue_token.py`, Alembic, `service/show_latest_feedback.py` |

There is **no server token env var** — auth is per-user hashed tokens stored in
the DB. See [service.md](service.md#auth-model-per-user-hashed-tokens).

## Client (MCP + CLI)

| Name | Required | Default | Controls | Read by |
|------|----------|---------|----------|---------|
| `LOOPBACK_SERVICE_URL` | only as env override | persisted by `loopback auth` | The **base** service URL (no `/feedback`). Endpoint paths (`/feedback`, etc.) are derived per call by `core.wire.endpoint()`. | MCP `submit_feedback`, `loopback feedback list`, `loopback setup` |
| `LOOPBACK_TOKEN` | only as env override | persisted by `loopback auth` | Per-user bearer token (admin token required for `feedback list` / `GET /feedback`). | MCP `submit_feedback`, `loopback feedback list`, `loopback setup` |
| `LOOPBACK_DATA_DIR` | no | resolved (see below) | Explicit override for the per-machine state dir. | `loopback/core/data-dir.js` |
| `LOOPBACK_HARNESS` | no | auto-detected | Override the detected harness label (`client.harness`). Undocumented escape hatch; never written into config. | `loopback/core/data-dir.js` |
| `LOOPBACK_CLI` | no | absolute path baked by `setup` | Absolute path to `loopback/cli/index.js` used by the OpenCode tripwire plugin. | `adapters/opencode/plugins/loopback.ts` |

An env value that is empty or an unsubstituted template (contains `${`) is
treated as **unset**.

## Detection / other

| Name | Required | Default | Controls | Read by |
|------|----------|---------|----------|---------|
| `AI_AGENT` | no | — | Primary harness-detection input (format `<harness>_<version>_<mode>`, e.g. `claude-code_2-1-150_agent`); also yields the harness version. | `loopback/core/data-dir.js` |
| `USER` | no | — | Username added to the redaction pattern set (so the operator's username is scrubbed from excerpts). | `loopback/core/redact.js` |

Harness-specific fallbacks are also consulted when `AI_AGENT` is absent:
`CLAUDECODE` / `CLAUDE_CODE_ENTRYPOINT` / `CLAUDE_PLUGIN_ROOT` /
`CLAUDE_PLUGIN_DATA` → `claude-code`; `CODEX_SANDBOX` / `CODEX_HOME` → `codex`.

## Test-only

| Name | Required | Default | Controls | Read by |
|------|----------|---------|----------|---------|
| `LOOPBACK_MCP_ENTRY` | no | `loopback/mcp/index.js` | Points the MCP smoke test at a specific server entry (e.g. the bundle). | `loopback/test/mcp-smoke.js` |

## Data dir resolution chain

First usable value wins (`loopback/core/data-dir.js`):

1. `LOOPBACK_DATA_DIR`
2. `CLAUDE_PLUGIN_DATA` (Claude Code, when substituted)
3. `~/.claude/plugins/data/loopback` (when `CLAUDE_PLUGIN_ROOT` is set but the
   data var was not substituted)
4. `$XDG_DATA_HOME/loopback`
5. `~/.local/share/loopback`

## Harness detection chain

First match wins (`client.harness`; `loopback/core/data-dir.js`):

1. `LOOPBACK_HARNESS` (explicit override)
2. `AI_AGENT` prefix → `claude-code` / `opencode` / `codex`
3. `CLAUDECODE` / `CLAUDE_CODE_ENTRYPOINT` / `CLAUDE_PLUGIN_ROOT` /
   `CLAUDE_PLUGIN_DATA` → `claude-code`
4. `CODEX_SANDBOX` / `CODEX_HOME` → `codex`
5. otherwise undefined (the field is omitted rather than mislabeled)

---

See also: [service.md](service.md) · [cli.md](cli.md) · [mcp.md](mcp.md).
