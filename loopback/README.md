# loopback

Closes the feedback loop for AI coding agents. When a shipped skill or agent
produces a defect the user has to correct locally, loopback detects the likely
defect, identifies which skill/agent produced the corrected output, synthesizes a
generalizable, de-identified lesson, asks for per-send consent, and submits the
record to the central ingest service.

loopback is **harness-agnostic**: a shared core + an MCP server + a small CLI
(`loopback auth` + `loopback setup <harness>`). The **MCP server is the universal
interface** — the same portable `feedback-detector` skill drives the whole flow
by calling its tools, so it works identically under Claude Code, OpenCode, and
Codex.

This directory is the **npm package** (`@guidobuilds/loopback`). There is no
Claude Code plugin / marketplace: `loopback setup <harness>` writes each
harness's config directly. See the [root README](../README.md) for the project
overview + service.

## Install

```sh
# 1. Write credentials once (lives in ~/.loopback/config.json @ 0600)
npx @guidobuilds/loopback auth --service-url <url> --token <tok>

# 2. Install into each harness you use (idempotent; safe to re-run)
npx @guidobuilds/loopback setup claude-code --automatic-feedback-detection
npx @guidobuilds/loopback setup opencode
npx @guidobuilds/loopback setup codex
```

`auth` is the single source of credentials; `setup <harness>` wires the MCP
server + detector skill + `/harness-feedback` command (+ optional hooks on
Claude Code via `--automatic-feedback-detection`). Restart your agent
afterward. Remove with `npx @guidobuilds/loopback uninstall <harness>` or
`uninstall --all`.

You need the central service running and a per-user token (issued by an admin
via `service/issue_token.py`).

## Credentials

Credentials live in a single file: `~/.loopback/config.json` (mode `0600`).
**Only `loopback auth` writes to it.** Every other command (`feedback list`,
`setup <harness>`, the MCP server) reads from it — no command accepts
`--service-url` / `--token` overrides. Authorization (admin vs user, revoked
tokens) is enforced server-side.

```sh
loopback auth --service-url <url> --token <tok>  # first install OR rotate both
loopback auth --token NEW_TOKEN                  # rotate just the bearer token
loopback auth --service-url https://new/         # change just the service URL
loopback auth --show                             # print resolved values (token redacted)
```

The service URL is the base; CLI and MCP derive endpoint paths (`/feedback`,
etc.) automatically.

**Resolution order** (same for every code path):

1. `~/.loopback/config.json` — the single source of truth
2. `LOOPBACK_TOKEN` / `LOOPBACK_SERVICE_URL` env vars — per-session override
   (useful for CI/scripts; not used by the CLI's day-to-day flow)
3. nothing → CLI exits 1 with a "run `loopback auth …`" hint; MCP server
   returns an error

## Review feedback

```sh
loopback feedback list --format json --all > feedback.json   # whole corpus (needs an ADMIN token)
loopback feedback list --severity high --artifact prd-writer # filtered table
```

`feedback list` reads its credentials from `~/.loopback/config.json` — rotate
to your admin token first (`loopback auth --token <admin>`).

## Layout

```
loopback/                       # npm package @guidobuilds/loopback
├── core/                       # shared lib: data-dir, redact, mutes, turn/session-state, wire
│   └── feedback-record.schema.json   # single source-of-truth wire contract
├── mcp/index.js · server.bundle.js   # MCP server source + prebuilt bundle (6 tools)
├── cli/index.js · auth.js · setup.js · feedback.js   # CLI router + verb modules
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

- **CLI reference** (all commands + `auth`/`setup`/`feedback list` flags, data
  dir, files setup writes) → [`../docs/cli.md`](../docs/cli.md)
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
