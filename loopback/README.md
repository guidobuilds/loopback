# loopback (MCP server + core)

This is the **`loopback` npm package** — the shared core, the MCP server, the
portable `feedback-detector` skill, and the `/harness-feedback` command that
together drive the loopback feedback loop.

loopback closes the feedback loop for AI coding agents. When a shipped skill or
agent produces a defect the user has to correct locally, the detector skill
judges defect vs. iteration, synthesizes a generalizable, de-identified lesson,
asks the user for per-send consent, and (on `[S]end`) submits the record to the
central ingest service via the MCP `submit_feedback` tool.

loopback is **harness-agnostic**: the same MCP server + the same portable
`feedback-detector` skill drive the flow under Claude Code, OpenCode, and Codex.
The MCP server is the universal interface — every harness calls the same six
tools through the same wire contract.

## Install

This package is **not installed directly** by developers. Use the
[`@loopback/setup`](../setup/) installer:

```bash
# Interactive: prompts for the agent + the service URL + the token.
npx @loopback/setup

# Non-interactive: pick the agent, pass credentials, skip prompts.
npx @loopback/setup claude-code --service-url <url> --token <tok> --yes
```

The installer extracts the bundled MCP server to `~/.loopback/mcp/`, writes
credentials to `~/.loopback/config.json` (mode `0600`), registers the MCP server
with the chosen agent, and copies the detector skill and command into the
agent's user directories. See [`../docs/install.md`](../docs/install.md) for the
full reference (flags, branches, reinstall detection, credential rotation,
uninstall).

You also need the central [service](../service/) running and a per-user token
(minted by an admin via `service/issue_token.py`).

## What's in this package

```
loopback/                              # npm package `loopback`
├── core/                              # shared lib: data-dir, redact, mutes, session-state, wire
│   └── feedback-record.schema.json    # single source-of-truth wire contract
├── mcp/
│   ├── index.js                       # MCP server source (six tools, stdio transport)
│   └── server.bundle.js               # prebuilt, dependency-free bundle (what `@loopback/setup` ships)
├── skills/feedback-detector/          # one portable detector skill (copied into each harness)
└── commands/harness-feedback.md       # slash command (copied into each harness)
```

The published package is **self-contained**: the MCP server is prebuilt into a
dependency-free bundle (`mcp/server.bundle.js`, via `npm run build` / bun), so
the install pulls **no runtime dependencies** (the four deps are
devDependencies, only needed to rebuild the bundle or run the tests).

## MCP tools (the developer-facing API)

The MCP server exposes six tools. These are the **recurring API** developers
interact with through their harness — there is no CLI equivalent.

| Tool | Purpose |
|------|---------|
| `submit_feedback` | Terminal POST after the user chose `[S]end` at the consent gate. Re-redacts, validates, and POSTs to the service. |
| `redact_preview` | Show the user the exact byte-for-byte text that would be sent (the consent gate uses this). |
| `is_muted` | Has the user muted this artifact on this machine? |
| `mute_artifact` | Mute an artifact on this machine (idempotent; backs `[N]ever for this skill`). |
| `record_signal` | Record a Tier-1 signal (correction / revert / reinstruct) observed this session. |
| `get_session_state` | Return the in-session debounce state + the local mute list. |

See [`../docs/mcp.md`](../docs/mcp.md) for inputs / outputs / registration.

## Credentials

Credentials live in a single file: `~/.loopback/config.json` (mode `0600`).
Only `@loopback/setup` writes to it. The MCP server reads from it at submit
time. `LOOPBACK_SERVICE_URL` / `LOOPBACK_TOKEN` env vars act as per-session
overrides (useful for CI / scripts).

Rotate by re-running the installer and answering `n` to the
"Use these credentials?" prompt:

```bash
npx @loopback/setup
```

or override directly with flags:

```bash
npx @loopback/setup --service-url <new> --token <new>
```

The service URL is the **base** (no `/feedback`); MCP derives endpoint paths
automatically. Authorization (admin vs user, revoked tokens) is enforced
server-side.

## Tests

```sh
npm run build       # rebuild mcp/server.bundle.js after editing core/ or mcp/
npm test            # core + MCP suite + installer-side smoke
```

## Documentation

- **Installer** (flags, branches, reinstall, uninstall, credential rotation) →
  [`../docs/install.md`](../docs/install.md)
- **MCP reference** (registration + the six tools) →
  [`../docs/mcp.md`](../docs/mcp.md)
- **Admin workflow** (run service, mint tokens, query feedback via curl) →
  [`../docs/admin.md`](../docs/admin.md)
- **Service reference** (endpoints, auth, persistence) →
  [`../docs/service.md`](../docs/service.md)
- **Environment variables** →
  [`../docs/environment-variables.md`](../docs/environment-variables.md)
- **Run it end to end** → [`../DEVELOPMENT.md`](../DEVELOPMENT.md)
- **Docs index** → [`../docs/README.md`](../docs/README.md)

## Privacy posture

De-identified by construction with per-send confirmation. Nothing leaves the
machine without an explicit `[S]end`; the redacted excerpt shown in the consent
gate is byte-for-byte what is sent. No raw artifact content is ever stored — only
a synthesized `summary` and a redacted `evidenceExcerpt`.
