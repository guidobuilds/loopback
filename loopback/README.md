# loopback

Closes the feedback loop for AI coding agents. When a shipped skill or agent
produces a defect the user has to correct locally, loopback detects the likely
defect, identifies which skill/agent produced the corrected output, synthesizes a
generalizable, de-identified lesson, asks for per-send consent, and submits the
record to the central ingest service.

loopback is **harness-agnostic**: a shared core + an MCP server + a CLI installer
(`loopback config`). The **MCP server is the universal interface** — the same
portable `feedback-detector` skill drives the whole flow by calling its tools, so
it works identically under Claude Code, OpenCode, and Codex.

This directory is the **npm package** (`@guidobuilds/loopback`). There is no
Claude Code plugin / marketplace: `loopback config` writes each harness's config
directly. See the [root README](../README.md) for the project overview + service.

## Install

```sh
# auto-detects your installed agents (or name them, e.g. `… config claude-code opencode`):
npx @guidobuilds/loopback config --service-url <url> --token <tok>
```

That single command is the whole install: it wires the MCP server + detector
skill + `/harness-feedback` command (+ hooks on Claude Code), writes your
credentials to `~/.loopback/config.json`, and auto-detects the originating
harness at runtime. Restart your agent afterward. Remove with
`npx @guidobuilds/loopback uninstall`.

You need the central service running and a per-user token (issued by an admin via
`service/issue_token.py`).

## Credentials

Credentials live in a single file: `~/.loopback/config.json` (mode `0600`). One
place, every harness + the CLI read from it. `loopback config` is the **only**
verb you need: the same command installs the first time, rotates credentials,
and re-syncs the harness configs — it's fully idempotent.

```sh
loopback config --service-url <url> --token <tok>  # first install OR rotate both
loopback config --token NEW_TOKEN                  # rotate just the bearer token
loopback config --service-url https://new/         # change just the service URL
loopback config                                    # idempotent re-sync (uses existing creds)
loopback config --show                             # print resolved values (token redacted)
```

The service URL is the base; CLI and MCP derive endpoint paths (`/feedback`,
etc.) automatically.

**Precedence** (same for every code path):

1. CLI flag (`--token`, `--service-url`)
2. Env var (`LOOPBACK_TOKEN`, `LOOPBACK_SERVICE_URL`) — per-session or per-harness override
3. `~/.loopback/config.json` — the single source of truth
4. nothing → CLI errors with exit 2; MCP server returns an error

**Per-harness override** (rare, advanced): add an `env`/`environment` block by
hand to that harness's MCP config (e.g. `~/.config/opencode/opencode.json`)
with `LOOPBACK_TOKEN` set to a different value. `loopback config` preserves
unrelated env entries on re-runs. *Caveat: Claude Code re-registers via the
`claude mcp` CLI on every `loopback config`, so a manual env block under
`mcpServers.loopback.env` in `~/.claude.json` must be re-applied after each
re-run.*

## Review feedback

```sh
loopback list --format json --all > feedback.json   # whole corpus (needs an ADMIN token)
loopback list --severity high --artifact prd-writer # filtered table
```

## Layout

```
loopback/                       # npm package @guidobuilds/loopback
├── core/                       # shared lib: data-dir, redact, mutes, turn/session-state, wire
│   └── feedback-record.schema.json   # single source-of-truth wire contract
├── mcp/index.js · server.bundle.js   # MCP server source + prebuilt bundle (6 tools)
├── cli/index.js · setup.js     # CLI + the one-command installer
├── skills/feedback-detector/   # one portable detector skill (copied into each harness)
├── commands/harness-feedback.md
├── hooks/on-*.js               # Claude Code tripwires
└── adapters/opencode/plugins/loopback.ts   # OpenCode tripwire plugin
```

The published package is **self-contained**: the MCP server is prebuilt into a
dependency-free bundle (`mcp/server.bundle.js`, via `npm run build` / bun), so the
install pulls **no runtime dependencies** (the four deps are devDependencies).

## Tests

```sh
npm run build                       # rebuild mcp/server.bundle.js after editing core/ or mcp/
npm test                            # core+MCP suite + installer suite
bun test/opencode-plugin-smoke.ts   # OpenCode plugin -> CLI -> core (needs bun)
```

## Documentation

- **CLI reference** (all commands + `config`/`list` flags, data dir, files
  `config` writes) → [`../docs/cli.md`](../docs/cli.md)
- **MCP reference** (registration + the six tools) →
  [`../docs/mcp.md`](../docs/mcp.md)
- **Environment variables** →
  [`../docs/environment-variables.md`](../docs/environment-variables.md)
- **Run it end to end** → [`../DEVELOPMENT.md`](../DEVELOPMENT.md) · **Docs index**
  → [`../docs/README.md`](../docs/README.md)

## Privacy posture

De-identified by construction with per-send confirmation. Nothing leaves the
machine without an explicit `[S]end`; the redacted excerpt shown in the consent
gate is byte-for-byte what is sent. No raw artifact content is ever stored — only
a synthesized `summary` and a redacted `evidenceExcerpt`.
