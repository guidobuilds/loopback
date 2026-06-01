# @guidobuilds/loopback-setup

Ephemeral, one-shot installer for [**loopback**](https://github.com/guidobuilds/loopback) —
the harness-agnostic feedback loop for AI coding agents. It registers the **remote**
loopback MCP endpoint and copies the `feedback-detector` skill + the `/harness-feedback`
command into your agent (Claude Code, OpenCode, or Codex). Run it via `npx`; it leaves
**no persistent CLI** behind.

## Usage

```bash
npx @guidobuilds/loopback-setup [agent] [options]
```

Run with no arguments for an interactive wizard (it auto-detects your agent and reuses
existing credentials when present):

```bash
npx @guidobuilds/loopback-setup
```

Non-interactive install:

```bash
npx @guidobuilds/loopback-setup claude-code --service-url <url> --token <token> --yes
```

## Arguments

| Argument | Values |
| --- | --- |
| `agent` | `claude-code` \| `opencode` \| `codex` |

## Options

| Option | Description |
| --- | --- |
| `--token <T>` | Override token (skip the auth prompt) |
| `--service-url <U>` | Override service URL (skip the auth prompt) |
| `-y, --yes` | Skip all prompts (take defaults) |
| `--force` | Reinstall even if already installed |
| `-r, --remove` | Uninstall mode |
| `--all` | With `--remove`: also delete `~/.loopback/` (the saved credentials) |
| `-h, --help` | Show help |
| `-v, --version` | Show version |

## What it does

1. Detects (or asks for) the target agent.
2. Resolves credentials from flags → `~/.loopback/config.json` → prompt.
3. Writes credentials to `~/.loopback/config.json` (mode `0600`).
4. Registers the **remote** MCP endpoint (`<service>/mcp`) + the `Authorization: Bearer` header with the agent (`claude mcp add-json` / `opencode.json` / `~/.codex/config.toml`).
5. Copies the `feedback-detector` skill and the `/harness-feedback` command into the agent's directories.

Credentials live only in `~/.loopback/config.json`. To rotate them, re-run the installer
with `--token` / `--service-url`, or answer `n` to the "use existing credentials?" prompt.

## Uninstall

```bash
npx @guidobuilds/loopback-setup --remove                # interactive picker
npx @guidobuilds/loopback-setup --remove claude-code    # specific agent
npx @guidobuilds/loopback-setup --remove --all          # also wipe ~/.loopback/
```

## Documentation

Full docs — install reference, MCP tools, service/admin workflow — live in the
[repository](https://github.com/guidobuilds/loopback).

## License

MIT
