# loopback documentation

This is the canonical reference for loopback — the harness-agnostic feedback loop
for AI coding agents (Claude Code, OpenCode, Codex). When a shipped skill or agent
produces a defect the user has to correct by hand, loopback turns that correction
into a de-identified, generalizable lesson and — with one tap of consent — sends
it to a central append-only store the artifact's authors can review.

## Reference

| Doc | Covers |
|-----|--------|
| [service.md](service.md) | The FastAPI ingest service: how to run it, endpoints, status codes, auth/token model, persistence, troubleshooting. |
| [cli.md](cli.md) | The `loopback` CLI: user-facing vs. internal commands, `setup`/`list` flags, the data dir, and the files `setup` writes per harness. |
| [mcp.md](mcp.md) | The MCP server: registration per harness and the six tools (inputs + output shapes). |
| [environment-variables.md](environment-variables.md) | Every env var (service, client, detection, test-only) plus the data-dir and harness-detection chains. |

## Getting started

- To **run loopback end to end from a checkout** (service in Docker + build/install
  the CLI), see [`../DEVELOPMENT.md`](../DEVELOPMENT.md).
- To **install the published package**, see [`../README.md`](../README.md) and
  [`../loopback/README.md`](../loopback/README.md)
  (`npx @guidobuilds/loopback config`).
- The **service** package README is [`../service/README.md`](../service/README.md).
