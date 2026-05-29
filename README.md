# loopback

> Automated, low-friction feedback for the skills and agents your org ships — Claude Code, OpenCode, Codex.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Version](https://img.shields.io/badge/version-0.0.1--beta-orange.svg)](https://github.com/guidobuilds/loopback/releases)

## The problem

Organizations are increasingly building their own harness — custom **skills, agents, and AGENTS.md** for their coding agents. But improving them depends on users bothering to report when something behaves wrong, or even fixing the skill themselves. Most of that signal is lost: the user just corrects the output locally and moves on.

**loopback automates the collection of that feedback and removes the friction of sharing it.** When a shipped skill or agent produces a defect a user has to correct by hand, loopback turns that correction into a de-identified, generalizable lesson and — with one tap of consent — sends it to a central store the skill's authors can review.

It is **harness-agnostic** (Claude Code, OpenCode, Codex) and **privacy-first**: nothing leaves the machine without explicit per-send confirmation, and no raw content is stored — only a synthesized summary and a redacted excerpt.

> ⚠️ Beta (0.0.1). APIs and the wire contract may change.

## How it works

1. The user corrects a skill / agent output.
2. A detector skill — driven by the harness through the loopback MCP server — judges **defect vs. iteration** (precision-biased) and synthesizes a generalizable lesson.
3. It shows a consent gate with the exact redacted text that would be sent: **[S]end · [E]dit · [D]ecline · [N]ever**.
4. On `[S]end`, the MCP tool re-redacts, validates, and POSTs to the central service.
5. The append-only service stores every de-identified record; authors review them via a token-guarded read-back.

## Components

loopback ships three pieces:

| Component | What it is | Where it lives |
|-----------|------------|----------------|
| **Installer** (`@loopback/setup`) | Ephemeral one-shot `npx` installer. Wires the MCP server, skill, and `/harness-feedback` command into your harness. No persistent CLI is left behind. | npm package `@loopback/setup`, source in [`setup/`](setup/) |
| **MCP server** (bundled) | The universal interface to loopback (six tools: `submit_feedback`, `redact_preview`, `mute_artifact`, `is_muted`, `record_signal`, `get_session_state`). Same `feedback-detector` skill drives it under every harness. | npm package `loopback`, source in [`loopback/`](loopback/) |
| **Service** (FastAPI) | Append-only ingest + token-guarded read-back. Per-user hashed-token bearer auth, SQLite + Alembic. | [`service/`](service/) |

## Quick start (developer)

Install loopback into your harness with one command:

```bash
# Interactive wizard (recommended) — prompts for agent + service URL + token:
npx @loopback/setup

# Or non-interactive with overrides:
npx @loopback/setup claude-code --service-url <url> --token <token> --yes
```

Then open your agent and try `/harness-feedback` — or just correct a skill's output and let the detector raise the consent gate.

To uninstall:

```bash
npx @loopback/setup --remove                # interactive picker
npx @loopback/setup --remove claude-code    # specific agent
npx @loopback/setup --remove --all          # also wipe ~/.loopback/ (credentials + bundled MCP server)
```

See [`docs/install.md`](docs/install.md) for the full installer reference.

## Quick start (admin / harness owner)

You need three things up: the central service, an admin token, and an HTTP client (`curl` works fine).

```bash
# 1. Run the service.
cd service
docker compose up --build -d                 # append-only store; persists to a named volume

# 2. Mint an admin token (reads feedback back).
docker compose exec loopback-svc python3 issue_token.py --email you@example.com --admin

# 3. Mint a developer token (POSTs feedback only).
docker compose exec loopback-svc python3 issue_token.py --email dev@example.com

# 4. Query stored feedback as the admin.
curl -H "Authorization: Bearer $ADMIN_TOKEN" "http://localhost:8080/feedback?severity=high&limit=50"
```

See [`docs/admin.md`](docs/admin.md) for full query examples (filters, pagination, jq pretty-printing) and [`docs/service.md`](docs/service.md) for the endpoint/auth/persistence reference.

## Documentation

The canonical reference lives in [`docs/`](docs/README.md):

- [docs/install.md](docs/install.md) — `npx @loopback/setup`: agents, flags, interactive branches, reinstall detection, credential rotation.
- [docs/admin.md](docs/admin.md) — admin workflow: run the service, mint tokens, query `GET /feedback` via `curl` with all filters.
- [docs/mcp.md](docs/mcp.md) — the MCP server: registration per harness and the six tools (the developer-facing API of recurring use — there is no CLI equivalent).
- [docs/service.md](docs/service.md) — service: endpoints, status codes, auth/token model, persistence, troubleshooting.
- [docs/environment-variables.md](docs/environment-variables.md) — every env var + the data-dir and harness-detection chains.

To run loopback end to end from a checkout, see [`DEVELOPMENT.md`](DEVELOPMENT.md).
Package READMEs: [`loopback/`](loopback/README.md) (MCP server + core) · [`setup/`](setup/) (installer) · [`service/`](service/README.md).

## Layout

```
setup/      # npm package @loopback/setup: ephemeral installer (TypeScript + tsup)
loopback/   # npm package `loopback`: shared core + MCP server (bundle) + skill + command
service/    # FastAPI + SQLite append-only ingest service (Docker, tests, e2e)
docs/       # user-facing reference (install, admin, mcp, service, env)
tests/      # model-driven detector precision suite
```

## Status

Beta (0.0.1): the installer, the MCP server, the detector skill, and the append-only service are implemented and tested end-to-end.

## Contributing

Issues and PRs welcome.

## License

[MIT](LICENSE) © 2026 Guido Caffa
