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
directly. See the [root README](../README.md) for install + the central service.

## Status

MVP, append-only (no registry). Shipping: the shared core, the `loopback` MCP
server (prebuilt bundle), the `loopback setup` installer, the portable detector
skill, and harness wiring for **Claude Code**, **OpenCode**, and **Codex** (all via
`setup`; Codex unverified on a live install). The FastAPI service is under `../service`.

## Install

```sh
npx @guidobuilds/loopback setup --ingest-url <url> --token <tok>   # auto-detects agents
```

## Layout

```
loopback/                       # npm package @guidobuilds/loopback
├── core/                       # GENERAL lib: data-dir, redact, anon-id, mutes,
│                               #   turn-state, session-state, wire (validate+POST)
│   └── feedback-record.schema.json   # single source-of-truth wire contract
├── mcp/
│   ├── index.js                #   MCP server SOURCE (6 tools)
│   └── server.bundle.js        #   prebuilt self-contained bundle (shipped; `npm run build`)
├── cli/
│   ├── index.js                #   CLI: setup/uninstall + core primitives (used by hooks)
│   └── setup.js                #   the one-command installer (per-harness config injection)
├── skills/feedback-detector/   # ONE portable skill (copied into each harness)
├── commands/harness-feedback.md # canonical /harness-feedback command (copied into each harness)
├── hooks/on-*.js               # Claude Code tripwires (wired into ~/.claude/settings.json)
├── adapters/opencode/plugins/loopback.ts   # OpenCode tripwire plugin (copied + path-baked)
└── test/                       # client + installer test runners
```

## Runtime / configuration

- Node only (built-in `fetch`). The published package is **self-contained**: the
  MCP server is prebuilt into a dependency-free bundle (`mcp/server.bundle.js`, via
  `npm run build` / bun) and the hooks/CLI are stdlib-only, so the install pulls
  **no runtime dependencies**. The 4 deps (`@modelcontextprotocol/sdk`, `ajv`,
  `ajv-formats`, `zod`) are **devDependencies** — only needed to rebuild the bundle
  or run the tests.
- The submit path reads `LOOPBACK_INGEST_URL` and the per-user bearer token
  `LOOPBACK_TOKEN` (issued by an admin via the service's `issue_token.py`).
  The originating harness (`client.harness`: `claude-code` | `opencode` | `codex`)
  is **auto-detected at runtime** from the launching harness's environment
  (`AI_AGENT`, else harness-specific markers; omitted if unknown) — nothing is
  configured per harness.
- Mutable per-machine state (anon-id salt, mutes, turn bookkeeping) lives in the
  data dir resolved by `core/data-dir.js`: `LOOPBACK_DATA_DIR` → `CLAUDE_PLUGIN_DATA`
  (Claude Code) → `$XDG_DATA_HOME/loopback` → `~/.local/share/loopback`.

## The feedback record contract

`core/feedback-record.schema.json` is the single source-of-truth wire contract
(design §5), reused by the client (ajv) and the central FastAPI service (pydantic),
kept in lockstep by `service/tests/test_contract.py`.

Required fields: `id`, `schemaVersion`, `artifact.kind` (`skill` | `agent` |
`artifact`), and `summary`. No raw artifact content is ever stored — only the
summary plus a redacted excerpt. `client.harness` records the originating harness.

## Tests

```sh
npm run build                    # rebuild mcp/server.bundle.js after editing core/ or mcp/
npm test                         # core+MCP suite (test/run.js) + installer suite (test/setup-smoke.js)
bun test/opencode-plugin-smoke.ts   # OpenCode plugin -> CLI -> core (needs bun)
```

## Privacy posture

De-identified by construction with per-send confirmation. Nothing leaves the
machine without an explicit `[S]end`; the redacted excerpt shown in the consent
gate is byte-for-byte what is sent.
