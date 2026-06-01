# Changelog

All notable changes to loopback are documented here. This project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.0] — 2026-06-01

**The MCP moved server-side.** The loopback MCP is no longer a client-side stdio
bundle installed onto each machine — it is now **hosted by the loopback service**
as a remote MCP, so MCP behaviour updates ship with the service and no client
re-install is needed to pick them up.

### Added
- **Server-hosted MCP** (`service/app/mcp_server.py`): the FastAPI service mounts a
  Streamable-HTTP MCP at `/mcp` (official `mcp` SDK) with static `Authorization:
  Bearer` auth validated against the existing per-user `tokens` table. The REST
  `POST /feedback` and the MCP `submit_feedback` tool now share one ingest core
  (`service/app/ingest.py`) so they cannot drift.

### Changed
- **Installer registers a remote endpoint instead of a bundle.** `@guidobuilds/loopback-setup`
  now writes `{type:"http"|"remote", url:"<service>/mcp", headers:{Authorization:
  "Bearer …"}}` per harness (Claude Code / OpenCode / Codex) and copies the skill +
  command — no `server.bundle.js` is downloaded. The token is written into each
  harness's MCP registration header.
- **Redaction is done by the detector skill in-context** (then re-checked by the
  service as a quarantine safety net, which returns the offending `patterns` for a
  one-shot re-redact + retry). The single source of truth for the wire contract is
  now `service/feedback-record.schema.json`.
- **Detector skill self-detects at every turn boundary** with no hook/tripwire
  dependency (highest-leverage change for auto-invocation).

### Removed
- The client-side MCP/core packages (`loopback/mcp`, `loopback/core`) and the
  shipped `server.bundle.js`. The `loopback` package is now just the
  `feedback-detector` skill + `/harness-feedback` command.
- **Tools:** `redact_preview`, `is_muted`, `mute_artifact`, `get_session_state`,
  and `record_signal`. The MCP surface is a single tool, `submit_feedback`.
- **Per-machine muting** (the `[N]ever for this skill` action) — removed for now.

### Breaking
- Existing 0.1.x (stdio-bundle) installs must **re-run the installer** to switch to
  the remote MCP. The service must run **0.2.0+** (it hosts the MCP endpoint).

[0.2.0]: https://github.com/guidobuilds/loopback/releases/tag/v0.2.0

## [0.1.0] — 2026-05-29

First public release on npm, published as **`@guidobuilds/loopback-setup`**.

### Added
- **Ephemeral installer** — `npx @guidobuilds/loopback-setup [agent]` wires the loopback
  MCP server, the `feedback-detector` skill, and the `/harness-feedback` command into
  Claude Code, OpenCode, or Codex. One-shot via `npx`; no persistent CLI is left behind.
- Interactive wizard with agent auto-detection and credential reuse from
  `~/.loopback/config.json`.
- Non-interactive flags: `--token`, `--service-url`, `--yes`, `--force`.
- Uninstall mode: `--remove [agent]`, plus `--all` to also wipe `~/.loopback/`.

### Changed
- **Replaced the persistent CLI** with the ephemeral installer. Feedback is now submitted
  exclusively through the MCP server and the `feedback-detector` skill — no hooks, no
  background turn-state tracking.
- **Wire contract:** the client no longer generates a record `id`. The service assigns the
  canonical id (`fb_<uuid>`) on ingest and returns it in the POST response. The
  feedback-record schema drops `id` from the request body.

### Notes
- Requires Node.js >= 18 (already present in the supported agents).
- The service (`service/`) must run the matching version that assigns ids server-side.

[0.1.0]: https://github.com/guidobuilds/loopback/releases/tag/v0.1.0
