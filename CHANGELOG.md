# Changelog

All notable changes to loopback are documented here. This project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.4.0] — 2026-07-21

**Proactive priming via a Claude Code plugin.** loopback now ships a real Claude
Code **plugin** (`loopback/plugin/claude-code/`, installable from the github
marketplace) whose hooks *prime* the `feedback-detector` deterministically — so the
detector can name the **real harness component** a user is correcting instead of
guessing, and can catch same-file reverts even after the write scrolled out of
context. This is the priming layer `SKILL.md` always anticipated: **hooks only prime;
they never decide a defect and never send anything.** Where the plugin is absent
(OpenCode, Codex, older Claude Code) the skill self-detects exactly as before.

### Added
- **Claude Code plugin** with `.claude-plugin/plugin.json`, a repo-root
  `.claude-plugin/marketplace.json`, `hooks/hooks.json`, and POSIX-sh hook scripts:
  - **SessionStart** builds a *harness-surface inventory* (installed skill/agent ids)
    and injects it so Step 3 attribution can name a real component.
  - **PostToolUse** appends written `file_path`s to a per-session *write-log* so the
    Step 1 same-file-revert signal is deterministic.
  - **UserPromptSubmit** injects a hard-debounced, correction-lexicon-gated nudge that
    re-states silence-by-default (never asserts a defect).
  - All scripts are jq-based, always exit 0, and degrade to `{}` if jq is absent — a
    priming failure never breaks a session. State lives locally under
    `~/.loopback/state/<session>/` and is never sent.
- **Installer** now installs the plugin on Claude Code via
  `claude plugin marketplace add` + `claude plugin install`, falling back to the
  legacy skill+command copy when `claude plugin` is unavailable. The MCP bearer token
  stays user-scoped and is never carried in the plugin.
- **Tests:** a plugin drift guard + manifest-consistency + hook-behavior suite
  (`loopback/test/`), plus attribution assertions on the primed recall scenarios and a
  precision-with-priming anti-regression scenario (`tests/detector/`).

### Changed
- **`feedback-detector` skill** (`SKILL.md` + `reference.md`) now *consumes* priming
  when present (inventory + write-log) to strengthen Signal 2 and Step 3 attribution,
  while keeping the pure self-detection fallback and every precision gate unchanged.
  `harness-feedback.md` mirrors the guidance.

_No `service/` changes; the loopback service stays at 0.2.0._

## [0.3.0] — 2026-06-13

**Clearer, self-typed feedback.** The `feedback-detector` skill now synthesizes
lessons that make the nature of the defect evident from the wording alone —
**technical / code** (e.g. out-of-scope edits, wrong class/definition, missing
typing, wrong API or structure) vs **behavioral / flow** (e.g. over-confirming, a
skipped promised step, an ignored standing convention) — and that are actionable
enough for a maintainer to fix the skill. There is no schema or wire-contract
change: the type is carried by the lesson prose, not a new field.

### Changed
- **Detector synthesis (Step 5)** now rewrites the lesson to be clear, actionable,
  and self-typed, with worked good/bad examples per defect type
  (`loopback/skills/feedback-detector/SKILL.md` and `reference.md`). The
  `/harness-feedback` manual command mirrors the same guidance.
- The consent gate format is unchanged (no category line) — the type reads
  directly from the `Lesson:` text.

### Internal
- Scaled the feedback-detector eval suite to 30 model-driven scenarios across
  four dimensions — precision, recall, redaction, and a new **synthesis**
  dimension graded by an LLM rubric judge — with streaming progress / Ctrl-C
  handling and a `--save-outputs` flag to inspect per-scenario output
  (`tests/detector/`).

_No `service/` changes; the loopback service stays at 0.2.0._

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
