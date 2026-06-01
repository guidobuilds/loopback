# loopback (skill + command)

This is the **`loopback` npm package** — the portable `feedback-detector` skill
and the `/harness-feedback` command that drive the loopback feedback loop in every
harness. The MCP server is **no longer in this package**: it is **hosted by the
loopback [service](../service/)** as a remote MCP (see [`../docs/mcp.md`](../docs/mcp.md)).

loopback closes the feedback loop for AI coding agents. When a shipped skill or
agent produces a defect the user has to correct locally, the detector skill judges
defect vs. iteration, synthesizes a generalizable, de-identified lesson, **redacts
the excerpt in context**, asks the user for per-send consent, and (on `[S]end`)
submits the record to the central service via the hosted MCP's `submit_feedback`
tool.

loopback is **harness-agnostic**: the same portable `feedback-detector` skill
drives the flow under Claude Code, OpenCode, and Codex, calling the one remote MCP
tool through the same wire contract.

## Install

This package is **not installed directly** by developers. Use the
[`@guidobuilds/loopback-setup`](../setup/) installer:

```bash
# Interactive: prompts for the agent + the service URL + the token.
npx @guidobuilds/loopback-setup

# Non-interactive: pick the agent, pass credentials, skip prompts.
npx @guidobuilds/loopback-setup claude-code --service-url <url> --token <tok> --yes
```

The installer registers the **remote** loopback MCP endpoint (`<service>/mcp`) with
the chosen agent (writing the `Authorization: Bearer` header), writes credentials
to `~/.loopback/config.json` (mode `0600`), and copies the detector skill +
command into the agent's user directories. See
[`../docs/install.md`](../docs/install.md) for the full reference.

You also need the central [service](../service/) running (it hosts the MCP) and a
per-user token (minted by an admin via `service/issue_token.py`).

## What's in this package

```
loopback/
├── skills/feedback-detector/    # the portable detector skill (SKILL.md + reference.md)
└── commands/harness-feedback.md # the /harness-feedback slash command
```

Two assets, copied into each harness by the installer. No runtime dependencies and
no build step.

## The MCP tool (the developer-facing API)

The skill drives a single remote tool, **`submit_feedback`**, hosted by the
service at `<service>/mcp`. It is the recurring API developers interact with
through their harness — there is no CLI equivalent. Redaction is performed by the
skill in context (the service re-checks as a quarantine safety net). See
[`../docs/mcp.md`](../docs/mcp.md) for inputs / outputs / registration.

## Credentials

The installer saves the service URL + token to `~/.loopback/config.json` (mode
`0600`) and writes the token into each harness's MCP registration as a bearer
header (the remote server reads it from the request). Rotate by re-running the
installer:

```bash
npx @guidobuilds/loopback-setup --service-url <new> --token <new>
```

The service URL is the **base** (no path); the installer appends `/mcp`.
Authorization (admin vs user, revoked tokens) is enforced server-side.

## Documentation

- **Installer** → [`../docs/install.md`](../docs/install.md)
- **MCP reference** → [`../docs/mcp.md`](../docs/mcp.md)
- **Admin workflow** → [`../docs/admin.md`](../docs/admin.md)
- **Service reference** → [`../docs/service.md`](../docs/service.md)
- **Environment variables** → [`../docs/environment-variables.md`](../docs/environment-variables.md)
- **Run it end to end** → [`../DEVELOPMENT.md`](../DEVELOPMENT.md)

## Privacy posture

De-identified by construction with per-send confirmation. Nothing leaves the
machine without an explicit `[S]end`; the excerpt the skill redacts in context and
shows in the consent gate is byte-for-byte what is sent. No raw artifact content is
ever stored — only a synthesized `summary` and a redacted `evidenceExcerpt`. The
service re-checks redaction and quarantines anything that slipped through.
