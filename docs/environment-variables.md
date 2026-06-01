# Environment variables

loopback uses no `.env` files. The few variables below are read directly from the
process environment.

**Client credentials are not environment variables.** The service URL + token are
passed to `@guidobuilds/loopback-setup` as flags (or reused from
`~/.loopback/config.json`) and written into each harness's remote-MCP
registration as an `Authorization: Bearer` header. The hosted MCP authenticates
from that header — there is no client process reading `LOOPBACK_*` at runtime.

## Service

| Name | Required | Default | Controls | Read by |
|------|----------|---------|----------|---------|
| `DB_PATH` | no | `/tmp/loopback.db` locally, `/data/loopback.db` in the image | SQLite DB path for the service, `issue_token.py`, and Alembic. | `service/app/main.py`, `service/issue_token.py`, Alembic, `service/show_latest_feedback.py` |

There is **no server token env var** — auth is per-user hashed tokens stored in
the DB. See [service.md](service.md#auth-model-per-user-hashed-tokens).

## Installer (agent detection / cosmetics)

Consulted only by `@guidobuilds/loopback-setup` to pre-select the detected agent
and to suppress the ASCII logo when it runs inside an agent. None are required.

| Name | Controls |
|------|----------|
| `AI_AGENT` | loopback's canonical "running inside an agent" signal (format `<harness>_<version>_<mode>`, e.g. `claude-code_2-1-150_agent`); suppresses the installer logo. |
| `CLAUDECODE` / `CLAUDE_CODE` | Claude Code fingerprint. |
| `OPENCODE` / `OPENCODE_HARNESS` | OpenCode fingerprint. |
| `CODEX` | Codex fingerprint. |

All read by `setup/src/detect-agent.ts` (a non-empty value on any one is enough).

> The harness label stamped on a record (`client.harness`) is no longer derived
> from the environment: the detector skill passes the `harness` argument to
> `submit_feedback` directly (it knows which harness it is running under).

---

See also: [service.md](service.md) · [install.md](install.md) ·
[admin.md](admin.md) · [mcp.md](mcp.md).
