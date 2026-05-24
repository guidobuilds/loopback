# loopback

Closes the feedback loop for AI coding agents. When a shipped skill or agent
produces a defect the user has to correct locally, loopback detects the likely
defect, identifies which skill/agent produced the corrected output, synthesizes a
generalizable, de-identified lesson, asks for per-send consent, and submits the
record to the central ingest service.

loopback is **harness-agnostic**: a shared core + an MCP server + a CLI installer
(`loopback setup`). The **MCP server is the universal interface** — the same
portable `feedback-detector` skill drives the whole flow by calling its tools, so
it works identically under Claude Code, OpenCode, and Codex.

This directory is the **npm package** (`@guidobuilds/loopback`). There is no
Claude Code plugin / marketplace: `loopback setup` writes each harness's config
directly. See the [root README](../README.md) for the project overview + service.

## Install

```sh
# auto-detects your installed agents (or name them, e.g. `… setup claude-code opencode`):
npx @guidobuilds/loopback setup --ingest-url <url> --token <tok>
```

It wires the MCP server + detector skill + `/harness-feedback` command (+ hooks on
Claude Code), is safe to re-run, and auto-detects the originating harness at
runtime. Restart your agent afterward. Remove with
`npx @guidobuilds/loopback uninstall`.

You need the central service running and a per-user token (issued by an admin via
`service/issue_token.py`). The submit path reads `LOOPBACK_INGEST_URL` and the
bearer token `LOOPBACK_TOKEN`; `loopback setup` bakes those into each harness's
MCP config.

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

- **CLI reference** (all commands + `setup`/`list` flags, data dir, files `setup`
  writes) → [`../docs/cli.md`](../docs/cli.md)
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
