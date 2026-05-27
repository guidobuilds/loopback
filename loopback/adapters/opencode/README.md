# loopback — OpenCode adapter

Brings the harness-agnostic loopback feedback loop to [OpenCode](https://opencode.ai).
The shared core, MCP server (bundle), and CLI are reused unchanged; this directory
holds the OpenCode-specific glue (the tripwire plugin). **You don't install this by
hand** — `loopback config` does it for you.

## Install

```sh
npx @guidobuilds/loopback config opencode --service-url <url> --token <tok>
```

That single command:
- registers the MCP server in `~/.config/opencode/opencode.json` (`mcp.loopback`,
  pointing at the prebuilt bundle; credentials live in `~/.loopback/config.json`);
- installs `plugins/loopback.ts` into `~/.config/opencode/plugins/` (baking the
  absolute CLI path so no `LOOPBACK_CLI` export is needed);
- copies the portable skill into `~/.config/opencode/skills/feedback-detector/`;
- copies the `/harness-feedback` command into `~/.config/opencode/commands/`.

It's idempotent and preserves your existing `opencode.json`. The originating
harness (`client.harness`) is **auto-detected at runtime** — nothing to configure.

## Baseline vs. auto-detection

- **Baseline (solid):** MCP server + portable skill + `/harness-feedback` give the
  full synthesize → consent → submit flow. The model sees the user's corrections in
  the conversation and runs the skill; nothing leaves the machine without `[S]end`.
- **Auto-detection (best-effort):** the plugin records file writes
  (`tool.execute.after`) and scans user messages on the `event` bus. Unlike Claude
  Code, **OpenCode has no turn-blocking hook**, so the plugin cannot force the skill
  to run at the turn boundary — it only enriches the state the skill reads via the
  `get_session_state` MCP tool.

## ⚠️ Verify before relying on the plugin

The plugin's `event` handler feature-detects the user-message shape, which can vary
by OpenCode version. It **fails safe** (never throws; no-ops on an unrecognized
shape). Before depending on auto-detection, confirm against your installed OpenCode
that write/edit tool names match `WRITE_TOOLS` (file path at `input.args.filePath`)
and that user-message events expose role + text where `userText()` looks.

Run `opencode mcp list` to confirm the `loopback` MCP server is connected.
