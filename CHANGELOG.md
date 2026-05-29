# Changelog

All notable changes to loopback are documented here. This project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
