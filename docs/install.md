# Installer reference

`@guidobuilds/loopback-setup` is the **ephemeral, one-shot installer** for loopback. It wires
the bundled MCP server, the `feedback-detector` skill, and the
`/harness-feedback` command into your harness — then exits.

```bash
npx @guidobuilds/loopback-setup [agent] [options]
```

`agent` is one of `claude-code`, `opencode`, `codex`. Omit it to pick
interactively.

## Quick start

```bash
# Interactive wizard — prompts for agent + service URL + token:
npx @guidobuilds/loopback-setup

# Non-interactive — pick the agent, pass credentials, skip prompts:
npx @guidobuilds/loopback-setup claude-code --service-url <url> --token <tok> --yes
```

The installer:

1. Writes `~/.loopback/config.json` (mode `0600`) with the service URL + token.
2. Extracts the MCP server bundle to `~/.loopback/mcp/server.bundle.js`.
3. Registers the MCP server with the chosen agent (`claude mcp add-json` /
   `opencode.json(c)` / `~/.codex/config.toml`).
4. Copies the detector skill + slash-command into the agent's user directories.

Then restart your agent. **No hooks are injected** into your agent's settings.

## Options

| Flag | Effect |
|------|--------|
| `--token <T>` | Override the token (skip the token prompt). |
| `--service-url <U>` | Override the service URL (skip the URL prompt). The base URL — endpoint paths (`/feedback`, etc.) are derived per call. |
| `-y, --yes` | Skip every interactive prompt (take all defaults). |
| `--force` | Reinstall even if loopback is already wired into the chosen agent. |
| `-r, --remove` | Uninstall mode (un-wire the chosen agent). |
| `--all` | With `--remove`, also delete `~/.loopback/` (credentials + bundled MCP server). |
| `-h, --help` | Show help. |
| `-v, --version` | Print the installer version. |

Unknown flags exit `2` with a clear error.

## Interactive flow

### Agent selection

If you omit the positional `agent`, the installer scans for known agent CLIs
on `PATH` and prompts:

```
? Which agent do you want to install loopback into?
  ❯ Claude Code  (detected)
    OpenCode     (not detected)
    Codex        (not detected)
```

Detected agents sort to the top; the default arrow lands on the first detected
one. You can still install into an undetected agent (you may not have the CLI
on `PATH` yet).

### Auth wizard

The installer reads `~/.loopback/config.json` and branches:

**No config**: prompts for the service URL first, then the token (token input
is silent — keystrokes are not echoed):

```
Service URL: https://loopback.example.com
Token: ****************
```

**Complete config**: shows a redacted summary and offers to reuse:

```
✓ Found existing credentials for https://loopback.example.com (token: abc1****)
? Use these credentials? (Y/n)
```

- `Y` (default): keeps the file untouched, continues with the install.
- `n`: re-prompts for both fields, then atomically overwrites the file.

**Partial config**: prompts only for the missing field, with the existing
value offered as a default:

```
Service URL: (https://loopback.example.com)
Token: ****************
```

**Flag overrides**: `--token T` and/or `--service-url U` bypass the wizard
entirely. Passing one flag + a partial config will prompt only for the still-
missing field; passing both flags writes the config without any prompt.

### Reinstall detection

Before touching anything, the installer checks whether loopback is already
fully wired into the chosen agent:

- The MCP server is registered.
- The `feedback-detector` skill directory is present in the agent's skills dir.
- The `/harness-feedback` command file is present in the agent's commands dir.
- The MCP bundle exists at `~/.loopback/mcp/server.bundle.js`.

If all four are present:

```
✓ loopback is already installed in Claude Code
? Reinstall? (y/N)
```

`N` (default): no-op exit `0`. `y` or `--force`: full reinstall.

## Non-interactive mode

`--yes` skips every prompt and takes defaults:

- "Use existing credentials?" → **yes**, keep them.
- "Reinstall?" → **no**, don't reinstall (use `--force` to override).
- The uninstall confirmation → **yes**, proceed.
- "Also delete `~/.loopback/`?" → **no**, keep it (use `--all` to override).

TTY auto-detection: when `process.stdin.isTTY` is `false` (piped input, CI),
the installer behaves as if `--yes` was passed. If a required value is missing
under non-TTY mode (e.g. no token in config, no `--token` flag), the installer
exits `1` with a clear error instead of hanging.

```bash
# Fully non-interactive (CI / scripts):
npx @guidobuilds/loopback-setup claude-code --service-url $URL --token $TOKEN --yes

# Fully non-interactive with reinstall override:
npx @guidobuilds/loopback-setup claude-code --token $NEW_TOKEN --force --yes
```

## Uninstall

```bash
# Interactive picker — prompts for the agent.
npx @guidobuilds/loopback-setup --remove

# Specific agent.
npx @guidobuilds/loopback-setup --remove claude-code

# Skip the "Remove loopback from Claude Code?" confirmation.
npx @guidobuilds/loopback-setup --remove claude-code --yes

# Also delete ~/.loopback/ (credentials + bundled MCP server).
npx @guidobuilds/loopback-setup --remove --all --yes
```

`--remove` reverses what `install` wrote: it removes the MCP registration from
the chosen agent's config, deletes the skill directory + command file, and
prints a summary of what was removed (skipped items are labeled
`(not installed)` rather than treated as errors). Without `--all`, credentials
at `~/.loopback/config.json` are kept so a future `npx @guidobuilds/loopback-setup` can
reuse them.

The remove flow also unconditionally cleans up any legacy
`opencode/plugins/loopback.ts` plugin on disk (from old installs); the current
installer never writes that plugin.

## Rotating credentials

Re-run the installer and answer `n` to the "Use these credentials?" prompt:

```bash
npx @guidobuilds/loopback-setup
# ✓ Found existing credentials for https://loopback.example.com (token: abc1****)
# ? Use these credentials? (Y/n) n
# Service URL: https://loopback.example.com
# Token: ****************
```

Or override directly with flags (writes without prompting):

```bash
npx @guidobuilds/loopback-setup --token <new-token>                  # rotate token, keep URL
npx @guidobuilds/loopback-setup --service-url <new-url>              # rotate URL, keep token
npx @guidobuilds/loopback-setup --service-url <new> --token <new>    # rotate both
```

Then restart your agent for the new credentials to take effect.

## What gets written, per agent

The installer is idempotent — running it twice produces the same on-disk
state. Credentials live in `~/.loopback/config.json` (single source of truth);
the installer never writes per-agent `env` blocks for `LOOPBACK_*`.

### Claude Code

- Registers the MCP server at **user scope** via `claude mcp add-json loopback
  … -s user` (falls back to a warning if the `claude` CLI is not on `PATH`).
- Copies the detector skill to `~/.claude/skills/feedback-detector/`.
- Copies the command to `~/.claude/commands/harness-feedback.md`.

### OpenCode

- Adds an `mcp.loopback` entry to `opencode.jsonc` (preferred if present) else
  `opencode.json` under `$XDG_CONFIG_HOME/opencode` (or `~/.config/opencode`).
- Copies the skill to `<opencode-config>/skills/feedback-detector/` and the
  command to `<opencode-config>/commands/harness-feedback.md`.

### Codex

- Adds an `[mcp_servers.loopback]` block to `~/.codex/config.toml`. If you have
  manually added env entries under `[mcp_servers.loopback.env]`, they are
  preserved across re-runs.
- Copies the skill to `~/.agents/skills/feedback-detector/`.
- Copies the prompt to `~/.codex/prompts/harness-feedback.md`.

## Troubleshooting

- **Installer says `claude CLI not on PATH`** — the skill and command are
  still copied, but the MCP server is not registered. Install Claude Code,
  then re-run the installer to wire up MCP.
- **MCP tools not appearing in Claude Code** — confirm registration with
  `claude mcp list` / `claude mcp get loopback` (check the bundle path), then
  **restart** the harness. Asking the model to "list your MCP tools" is
  unreliable in headless `-p` runs.
- **Want to rotate your token** — re-run the installer and answer `n` to
  "Use these credentials?", or pass `--token <new>` directly.

---

See also: [mcp.md](mcp.md) · [admin.md](admin.md) ·
[service.md](service.md) · [environment-variables.md](environment-variables.md).
