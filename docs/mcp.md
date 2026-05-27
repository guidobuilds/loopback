# MCP reference

The loopback MCP server is the **universal interface**: it works identically
under Claude Code, OpenCode, and Codex. The portable `feedback-detector` skill /
`/harness-feedback` command drive the whole flow by calling these tools, so the
same `SKILL.md` needs no harness-specific shell-outs.

- **Transport:** stdio (one server process per session).
- **Source:** `loopback/mcp/index.js`, bundled to
  `loopback/mcp/server.bundle.js` via `npm run build` (uses bun). The bundle is
  self-contained and dependency-free; it is what ships in the npm package.
- **Command:** `node <absolute-path>/mcp/server.bundle.js`.

Nothing here makes a defect-vs-iteration judgment — that is the skill's job. The
server only validates, redacts, transmits, and tracks state the user approved.

## Registration

`loopback config` registers the server automatically per harness (see
[cli.md](cli.md#files-config-writes-per-harness)). The shapes it writes:

**Claude Code** (`claude mcp add-json loopback … -s user`):

```json
{ "command": "node", "args": ["<abs>/mcp/server.bundle.js"] }
```

**OpenCode** (`mcp.loopback` in `opencode.json(c)`):

```json
{ "type": "local", "command": ["node", "<abs>/mcp/server.bundle.js"],
  "enabled": true }
```

**Codex** (`~/.codex/config.toml`):

```toml
[mcp_servers.loopback]
command = "node"
args = ["<abs>/mcp/server.bundle.js"]
```

Credentials live in `~/.loopback/config.json` (single source of truth);
per-harness `env`/`environment` blocks are no longer written by `loopback
config`. Unrelated env keys the user added by hand are preserved across
re-runs (OpenCode / Codex).

## Environment

The server reads `LOOPBACK_SERVICE_URL` and `LOOPBACK_TOKEN` (the per-user
bearer) when submitting, then falls back to `~/.loopback/config.json`. The
service URL is the **base** (no `/feedback`); endpoint paths are derived per
call. The originating harness (`client.harness`) is **auto-detected at
runtime** from the launching harness's environment (primarily `AI_AGENT`, else
harness-specific markers; omitted if unknown) — nothing is configured per
harness. See [environment-variables.md](environment-variables.md).

## Tools

Six tools, all general:

### `submit_feedback`

Terminal POST after the user chose `[S]end` at the consent gate. Re-redacts
`summary`/`evidenceExcerpt`, validates against the wire contract, stamps
`client.{plugin,harness}`, and POSTs to the `/feedback` endpoint derived from
the configured service URL.

| Input | Type | Required | Notes |
|-------|------|----------|-------|
| `artifactKind` | `skill\|agent\|artifact` | yes | Kind of artifact. |
| `artifactId` | string | yes | e.g. `prd-writer`. |
| `artifactVersion` | string | no | e.g. `3.2.0`. |
| `artifactRepo` | string | no | Repo the user was working in (e.g. `git remote get-url origin`). |
| `summary` | string | yes | The synthesized, de-identified, generalizable lesson. |
| `workType` | string | no | Task category, e.g. `prd-authoring`. |
| `evidenceExcerpt` | string | no | Minimal, already-redacted excerpt the user approved. |
| `severity` | `low\|medium\|high` | no | Defect severity. |
| `confidence` | `low\|medium\|high` | no | Detector self-rating. |
| `clusterKey` | string | no | Proposed dedup key, e.g. `artifact:workType:problem`. |

Output: `{"status":"ok","issueUrl":<url|null>,"id":<server id>}` on success;
`{"status":"error","error":…}` (with `isError`) on validation/POST failure.

### `redact_preview`

Redact a candidate excerpt the same way `submit_feedback` will, and report
whether anything was removed (so the consent gate shows exactly-what-is-sent).

| Input | Type | Required |
|-------|------|----------|
| `text` | string | yes |

Output: `{"redacted":<string>,"changed":<bool>,"length":<int>}`.

### `is_muted`

Is this artifact muted on this machine?

| Input | Type | Required |
|-------|------|----------|
| `artifactId` | string | yes |

Output: `{"artifactId":<id>,"muted":<bool>}`.

### `mute_artifact`

Mute an artifact on this machine (backs `[N]ever for this skill`). Idempotent.

| Input | Type | Required |
|-------|------|----------|
| `artifactId` | string | yes |

Output: `{"status":"ok","artifactId":<id>,"muted":true}`.

### `get_session_state`

Return the in-session debounce state plus the local mute list (enforce "one
candidate per artifact per session" and respect mutes).

Input: none.

Output: `{"signals":[…],"raised":[…],"correctionCount":<int>,"muted":[…]}`.

### `record_signal`

Record a Tier-1 signal observed this session (useful on harnesses without hook
context). Does NOT decide a defect or send anything.

| Input | Type | Required | Notes |
|-------|------|----------|-------|
| `type` | `correction\|revert\|reinstruct` | yes | The kind of Tier-1 signal. |
| `artifactId` | string | no | Artifact the signal relates to, if known. |
| `note` | string | no | Short free-text note for context. |

Output: `{"status":"ok","recorded":<entry>,"state":<session state>}`.

---

See also: [cli.md](cli.md) · [environment-variables.md](environment-variables.md) ·
[service.md](service.md) · [`../DEVELOPMENT.md`](../DEVELOPMENT.md).
