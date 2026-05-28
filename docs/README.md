# loopback documentation

This is the canonical reference for loopback — the harness-agnostic feedback loop
for AI coding agents (Claude Code, OpenCode, Codex). When a shipped skill or agent
produces a defect the user has to correct by hand, loopback turns that correction
into a de-identified, generalizable lesson and — with one tap of consent — sends
it to a central append-only store the artifact's authors can review.

## Reference

| Doc | Covers |
|-----|--------|
| [install.md](install.md) | `npx @loopback/setup`: agents, flags, interactive branches, reinstall detection, credential rotation, uninstall. |
| [admin.md](admin.md) | Admin workflow: run the service, mint tokens with `issue_token.py`, query `GET /feedback` via `curl` with all filters. |
| [mcp.md](mcp.md) | The MCP server: registration per harness and the six tools (the developer-facing API of recurring use — there is no CLI equivalent). |
| [service.md](service.md) | The FastAPI ingest service: endpoints, status codes, auth/token model, persistence, troubleshooting. |
| [environment-variables.md](environment-variables.md) | Every env var (service, client, detection, test-only) plus the data-dir and harness-detection chains. |

## Getting started

- To **install loopback into your harness**, see [install.md](install.md) and
  the top-level [`../README.md`](../README.md): `npx @loopback/setup`.
- To **read feedback back as an admin**, see [admin.md](admin.md): run the
  service, mint an admin token, query `GET /feedback` with `curl`.
- To **run loopback end to end from a checkout** (service in Docker + build the
  installer), see [`../DEVELOPMENT.md`](../DEVELOPMENT.md).
- The **service** package README is [`../service/README.md`](../service/README.md);
  the **installer** package is [`../setup/`](../setup/); the **MCP server +
  core** package is [`../loopback/README.md`](../loopback/README.md).
