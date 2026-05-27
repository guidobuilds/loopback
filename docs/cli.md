# CLI reference

`loopback` is the harness-agnostic command-line entrypoint (npm package
`@guidobuilds/loopback`, bin `loopback`, source `loopback/cli/index.js`). It is
intentionally stdlib-only (no third-party arg parser).

## Install / build

```bash
# published package (auto-detects installed agents):
npx @guidobuilds/loopback config --service-url <url> --token <tok>

# from a checkout (run the local CLI directly):
cd loopback && npm install && npm run build   # build mcp/server.bundle.js (uses bun)
node cli/index.js <command> …
```

The published npm package is self-contained (the MCP server is a prebuilt,
dependency-free bundle); the four deps are `devDependencies`, only needed to
rebuild the bundle or run the tests.

## User-facing commands

| Command | Purpose |
|---------|---------|
| `config [harness…] [--service-url URL] [--token TOK] [--automatic-feedback-detection]` | Install loopback into one or more harnesses **and** write credentials to `~/.loopback/config.json`. With no harness names, **auto-detects** installed agents. Idempotent — same verb for first install, credential rotation, and re-sync. `--service-url` is the **base** service URL (no `/feedback`); endpoint paths are derived per call. Claude Code hooks are opt-in: pass `--automatic-feedback-detection` to wire them. See [Files config writes](#files-config-writes-per-harness). |
| `config --show` | Print the resolved credentials (token redacted) and the config file path. Read-only. |
| `uninstall [harness…]` | Reverse `config` for the named (or auto-detected) harnesses. |
| `list [flags]` | Read stored feedback back from the admin-only `GET /feedback`. See [`list` flags](#list-flags). |
| `redact [text…]` | Redact stdin (or the args) and print to stdout. |
| `data-dir` | Print the resolved data dir (see [Data dir](#data-dir-resolution)). |
| `mute <id>` | Mute an artifact locally. |
| `mute --is-muted <id>` | Print `muted`/`not-muted`; exit `0` if muted, `1` if not. |
| `mute --list` | Print the mute list as JSON (`{"schemaVersion":1,"muted":[…]}`). |
| `mute --unmute <id>` | Remove an artifact from the mute list. |

Harness names are `claude-code`, `opencode`, `codex`.

### `config` flags

| Flag | Default | Effect |
|------|---------|--------|
| `--service-url URL` | — | Base service URL (no `/feedback`); stored in `~/.loopback/config.json`. |
| `--token TOK` | — | Bearer token; stored in `~/.loopback/config.json` (mode `0600`). |
| `--automatic-feedback-detection` | off | Install Claude Code hooks (`PostToolUse`, `UserPromptSubmit`, `Stop`, `SessionStart`) into `~/.claude/settings.json`. Without this flag the MCP server + skill + command are still installed; only the hooks are skipped. No effect on OpenCode/Codex. |
| `--show` | — | Read-only: print resolved credentials (token redacted) and the config file path. |

### `list` flags

`loopback list` requires an **admin** token (`GET /feedback` is admin-only)
and the base service URL (the `/feedback` path is appended internally). Flags
map onto the service's
[`GET /feedback`](service.md#get-feedback-pagination) query.

| Flag | Default | Effect |
|------|---------|--------|
| `--format table\|json` | `table` | Render a compact aligned table or pretty JSON. |
| `--all` | — | Return **every** record (sends `limit=0`; wins over `--limit`). |
| `--limit N` | `100` | Max records to return. |
| `--offset N` | `0` | Records to skip. |
| `--artifact ID` | — | Filter by `artifact.id`. |
| `--severity low\|medium\|high` | — | Filter by severity. |
| `--confidence low\|medium\|high` | — | Filter by confidence. |
| `--email ADDR` | — | Filter by submitter email. |
| `--from ISO` | — | Inclusive `received_from` (server receive time `>=`). |
| `--to ISO` | — | Inclusive `received_to` (server receive time `<=`). |
| `--service-url URL` | `$LOOPBACK_SERVICE_URL` | The base service URL (no `/feedback`). |
| `--token TOK` | `$LOOPBACK_TOKEN` | Admin bearer token. |

```bash
# whole corpus as JSON, e.g. to feed to a coding agent:
loopback list --format json --all > feedback.json
# filtered table: high-severity feedback for the prd-writer skill:
loopback list --severity high --artifact prd-writer
# page / filter by submitter / date range:
loopback list --limit 50 --offset 50
loopback list --email dev@example.com --from 2026-05-01T00:00:00Z --to 2026-05-31T00:00:00Z
```

A non-admin token returns a friendly `403`; a missing URL/token exits `2`.

## Internal / hook-facing commands

These back the deterministic tripwires (Claude Code hooks, OpenCode plugin) and
are not meant for direct day-to-day use.

| Command | Purpose |
|---------|---------|
| `scan-correction [text…]` | Exit `0` (+ prints `hit`) if correction-language is present, else `1` (+ `miss`). |
| `record-write --session <id> --file <path>` | Record that the agent wrote a file this turn. |
| `bump-correction --session <id>` | Increment + print the per-session re-instruction count. |
| `turn-state --session <id>` | Print the per-session turn-state JSON (`{state, primed}`). |

## Data dir resolution

The mutable per-machine state dir is resolved by
`loopback/core/data-dir.js`, in order (first usable wins):

1. `LOOPBACK_DATA_DIR` — explicit override.
2. `CLAUDE_PLUGIN_DATA` — Claude Code, when actually substituted.
3. `~/.claude/plugins/data/loopback` — Claude Code fallback (when
   `CLAUDE_PLUGIN_ROOT` is set but the data var was not substituted).
4. `$XDG_DATA_HOME/loopback` — generic XDG.
5. `~/.local/share/loopback` — generic default.

An env value that is empty or an unsubstituted template (contains `${`) is
treated as **unset** and skipped. Print the resolved dir with `loopback data-dir`.

### Files in the data dir

| File | Mode | Shape |
|------|------|-------|
| `mutes.json` | `0600` | `{"schemaVersion":1,"muted":["<artifact-id>", …]}` |
| `turn-state/<session>.json` | — | `{"writes":[{"file_path","at"}],"correctionPrompts":<n>}` (session id is sanitized for the filename) |

## Files `config` writes (per harness)

`config` is idempotent (read → merge → write, preserving your other settings) and
stores the **absolute** path to your checkout's `mcp/server.bundle.js`, so re-run
it after `npm run build` or moving the checkout.

### Claude Code

- Registers the MCP server at **user scope** via `claude mcp add-json loopback … -s user`.
- **Only when `--automatic-feedback-detection` is passed**, merges four hooks into
  `~/.claude/settings.json`: `PostToolUse` (matcher `Write|Edit`),
  `UserPromptSubmit`, `Stop`, `SessionStart`. Without the flag, existing hook
  entries (loopback or otherwise) are left untouched.
- Copies the detector skill to `~/.claude/skills/feedback-detector/`.
- Copies the command to `~/.claude/commands/harness-feedback.md`.

### OpenCode

- Adds an `mcp.loopback` entry to `opencode.jsonc` (preferred if present) else
  `opencode.json` under `$XDG_CONFIG_HOME/opencode` (or `~/.config/opencode`).
- Installs the tripwire plugin at `<config>/plugins/loopback.ts` (with the
  absolute CLI path baked in).
- Copies the skill to `<config>/skills/feedback-detector/` and the command to
  `<config>/commands/harness-feedback.md`.

### Codex

- Adds an `[mcp_servers.loopback]` block (and `[mcp_servers.loopback.env]` if
  secrets are set) to `~/.codex/config.toml`.
- Copies the skill to `~/.agents/skills/feedback-detector/`.
- Copies the prompt to `~/.codex/prompts/harness-feedback.md`.

`uninstall` reverses each of the above for the targeted harness (removes the MCP
registration, the hook entries, the plugin, and the copied skill/command/prompt).

## Troubleshooting

- **MCP tools not appearing (Claude Code)** — confirm `config` registered the
  server with `claude mcp list` / `claude mcp get loopback` (check the bundle path
  and `--service-url`/`--token`), then re-run `node cli/index.js config claude-code …`
  and **restart** the harness. Asking the model to "list your MCP tools" is
  unreliable in headless `-p` runs.

---

See also: [mcp.md](mcp.md) · [environment-variables.md](environment-variables.md) ·
[service.md](service.md) · [`../DEVELOPMENT.md`](../DEVELOPMENT.md).
