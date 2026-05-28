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

1. Deterministic tripwires notice when a user corrects skill/agent output.
2. A detector skill judges **defect vs. iteration** (precision-biased) and synthesizes a generalizable lesson.
3. It shows a consent gate with the exact redacted text that would be sent: **[S]end · [E]dit · [D]ecline · [N]ever**.
4. On `[S]end`, the MCP tool re-redacts, validates, and POSTs to the central service.
5. The append-only service stores every de-identified record; authors review them via a token-guarded read-back.

## Quickstart

### 1. Run the central service + mint a token

```bash
git clone https://github.com/guidobuilds/loopback.git
cd loopback/service
docker compose up --build -d                 # append-only store; persists to a volume
docker compose exec loopback-svc python3 issue_token.py --email you@example.com --admin  # reads feedback back
docker compose exec loopback-svc python3 issue_token.py --email dev@example.com           # client bearer
```

Auth is per-user, hashed at rest — no shared server token. (No Docker? Run it with `uvicorn` — see
[DEVELOPMENT.md](DEVELOPMENT.md).)

### 2. Configure credentials, then install into each agent

```bash
# 2a. Write credentials once (lives in ~/.loopback/config.json @ 0600)
npx @guidobuilds/loopback auth \
  --service-url http://localhost:8080 \
  --token "<the developer token from step 1>"

# 2b. Install into each harness you use (idempotent; safe to re-run)
npx @guidobuilds/loopback setup claude-code --automatic-feedback-detection
npx @guidobuilds/loopback setup opencode
npx @guidobuilds/loopback setup codex
```

### 3. Use it

Correct a skill/agent and accept the consent gate — or trigger it manually:

```
/harness-feedback prd-writer the PRD used a freeform structure instead of the template
```

Read the stored records back (rotate to your admin token first, then list):

```bash
npx @guidobuilds/loopback feedback list
```

## Documentation

The canonical reference lives in [`docs/`](docs/README.md):

- [docs/service.md](docs/service.md) — service: endpoints, status codes, auth/token model, persistence, troubleshooting.
- [docs/cli.md](docs/cli.md) — the `loopback` CLI: commands, `auth`/`setup`/`feedback list` flags, data dir, files setup writes.
- [docs/mcp.md](docs/mcp.md) — the MCP server: registration per harness and the six tools.
- [docs/environment-variables.md](docs/environment-variables.md) — every env var + the data-dir and harness-detection chains.

To run loopback end to end from a checkout, see [DEVELOPMENT.md](DEVELOPMENT.md).
Package READMEs: [`loopback/`](loopback/README.md) (npm client) ·
[`service/`](service/README.md).

## Layout

```
loopback/   # npm package: core + MCP server (bundle) + `loopback` CLI (auth / setup / feedback list) + skill + command + hooks
service/    # FastAPI + SQLite append-only ingest service (Docker, tests, e2e)
tests/      # model-driven detector precision suite
```

## Status

Beta (0.0.1): the full client loop and the append-only service are implemented and tested.

## Contributing

Issues and PRs welcome.

## License

[MIT](LICENSE) © 2026 Guido Caffa
