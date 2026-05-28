# CLI reference

`loopback` is the harness-agnostic command-line entrypoint (npm package
`@guidobuilds/loopback`, bin `loopback`, source `loopback/cli/index.js`). It is
intentionally stdlib-only (no third-party arg parser).

## Install / build

```bash
# published package — write credentials once, then install into each harness:
npx @guidobuilds/loopback auth --service-url <url> --token <tok>
npx @guidobuilds/loopback setup claude-code --automatic-feedback-detection
npx @guidobuilds/loopback setup opencode
npx @guidobuilds/loopback setup codex

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
| `auth [--service-url URL] [--token TOK]` | Write or rotate credentials in `~/.loopback/config.json` (mode `0600`). The **only** command that accepts `--service-url` / `--token`; every other command reads from the file. `--service-url` is the **base** service URL (no `/feedback`); endpoint paths are derived per call. Partial updates allowed (e.g. `--token` alone). |
| `auth --show` | Print the resolved credentials (token redacted), the schema version, and the config file path. Read-only. |
| `setup claude-code [--automatic-feedback-detection]` | Install loopback into Claude Code. Requires `auth` to have run first (exits 1 with a hint otherwise). `--automatic-feedback-detection` opt-in wires the four hooks; without it, only the MCP server + skill + command are installed. Idempotent. |
| `setup codex` | Install loopback into Codex. Requires `auth`. |
| `setup opencode` | Install loopback into OpenCode. Requires `auth`. |
| `uninstall <harness>` | Unwire a named harness (`claude-code` / `codex` / `opencode`). |
| `uninstall --all` | Unwire every detected harness. |
| `feedback list [flags]` | Read stored feedback back from the admin-only `GET /feedback`. Reads credentials from `~/.loopback/config.json` — does **not** accept `--service-url` / `--token`. See [`feedback list` flags](#feedback-list-flags). |
| `redact [text…]` | Redact stdin (or the args) and print to stdout. |
| `data-dir` | Print the resolved data dir (see [Data dir](#data-dir-resolution)). |
| `mute <id>` | Mute an artifact locally. |
| `mute --is-muted <id>` | Print `muted`/`not-muted`; exit `0` if muted, `1` if not. |
| `mute --list` | Print the mute list as JSON (`{"schemaVersion":1,"muted":[…]}`). |
| `mute --unmute <id>` | Remove an artifact from the mute list. |

Harness names are `claude-code`, `opencode`, `codex`.

### `feedback list` flags

`loopback feedback list` requires an **admin** token (`GET /feedback` is
admin-only). Credentials come from `~/.loopback/config.json` — rotate with
`loopback auth --token <admin>` if your saved token is user-scope. Flags map
onto the service's
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

```bash
# whole corpus as JSON, e.g. to feed to a coding agent:
loopback feedback list --format json --all > feedback.json
# filtered table: high-severity feedback for the prd-writer skill:
loopback feedback list --severity high --artifact prd-writer
# page / filter by submitter / date range:
loopback feedback list --limit 50 --offset 50
loopback feedback list --email dev@example.com --from 2026-05-01T00:00:00Z --to 2026-05-31T00:00:00Z
```

A non-admin token returns a friendly `403`; missing credentials exit `1` with
a hint to run `loopback auth …`.

## Internal / hook-facing commands

These back the deterministic tripwires (the OpenCode plugin shells out to them;
Claude Code hooks call `core/*` directly). Not meant for direct day-to-day use.

| Command | Purpose |
|---------|---------|
| `internal scan-correction [text…]` | Exit `0` (+ prints `hit`) if correction-language is present, else `1` (+ `miss`). |
| `internal record-write --session <id> --file <path>` | Record that the agent wrote a file this turn. |
| `internal bump-correction --session <id>` | Increment + print the per-session re-instruction count. |
| `internal turn-state --session <id>` | Print the per-session turn-state JSON (`{state, primed}`). |

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

## Files `setup <harness>` writes (per harness)

`setup <harness>` is idempotent (read → merge → write, preserving your other
settings) and stores the **absolute** path to your checkout's
`mcp/server.bundle.js`, so re-run it after `npm run build` or moving the
checkout. Credentials are **not** injected into per-harness env blocks — the
MCP server reads them from `~/.loopback/config.json` at submit time.

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

- Adds an `[mcp_servers.loopback]` block to `~/.codex/config.toml`. If you have
  manually added env entries under `[mcp_servers.loopback.env]`, they are
  preserved across re-runs.
- Copies the skill to `~/.agents/skills/feedback-detector/`.
- Copies the prompt to `~/.codex/prompts/harness-feedback.md`.

`uninstall <harness>` reverses each of the above (removes the MCP
registration, the hook entries, the plugin, and the copied skill/command/prompt).

## Troubleshooting

- **`setup <harness>` exits 1** — run `loopback auth --service-url <url>
  --token <tok>` first; `setup` refuses to write a half-configured install.
- **MCP tools not appearing (Claude Code)** — confirm `setup claude-code`
  registered the server with `claude mcp list` / `claude mcp get loopback`
  (check the bundle path), then re-run `node cli/index.js setup claude-code …`
  and **restart** the harness. Asking the model to "list your MCP tools" is
  unreliable in headless `-p` runs.
- **`feedback list` returns 403** — your saved token is user-scope; rotate to
  the admin token: `loopback auth --token <admin>`.

---

See also: [mcp.md](mcp.md) · [environment-variables.md](environment-variables.md) ·
[service.md](service.md) · [`../DEVELOPMENT.md`](../DEVELOPMENT.md).
