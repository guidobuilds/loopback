# loopback — OpenCode

Brings the harness-agnostic loopback feedback loop to
[OpenCode](https://opencode.ai). The shared core and MCP server (bundle) are
reused unchanged; OpenCode-specific wiring is handled by `@guidobuilds/loopback-setup`.

There is **no OpenCode plugin and no tripwire glue** — the detector skill is
driven by description-match, and all interactions go through the MCP server's
six tools. This directory remains as a placeholder for any future
OpenCode-specific adapter code; today there is none.

## Install

```sh
npx @guidobuilds/loopback-setup opencode
```

`@guidobuilds/loopback-setup opencode`:

- registers the MCP server in `~/.config/opencode/opencode.json(c)` under
  `mcp.loopback` (pointing at `~/.loopback/mcp/server.bundle.js`; credentials
  live in `~/.loopback/config.json`);
- copies the portable detector skill into
  `~/.config/opencode/skills/feedback-detector/`;
- copies the `/harness-feedback` command into
  `~/.config/opencode/commands/harness-feedback.md`.

The installer is idempotent and preserves any other keys in your
`opencode.json(c)`. See [`../../../docs/install.md`](../../../docs/install.md)
for the full flag reference.

## Verify the install

```sh
opencode mcp list
```

Confirm `loopback` appears as a connected MCP server. The same six tools
(`submit_feedback`, `redact_preview`, `mute_artifact`, `is_muted`,
`record_signal`, `get_session_state`) are available; the detector skill drives
the flow identically to other harnesses.

For the MCP tool reference see
[`../../../docs/mcp.md`](../../../docs/mcp.md).
