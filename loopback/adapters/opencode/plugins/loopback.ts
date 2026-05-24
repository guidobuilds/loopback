import type { Plugin } from "@opencode-ai/plugin"

/**
 * loopback — OpenCode adapter (deterministic tripwires).
 *
 * The OpenCode counterpart of the Claude Code hooks. It only PRIMES per-session
 * state via the loopback CLI (which writes to the shared loopback data dir); it
 * never judges a defect or sends anything. Judgment + the per-send consent gate
 * are the feedback-detector skill's job, driven through the loopback MCP server's
 * tools (the same portable SKILL.md works under OpenCode via .claude/skills/ or
 * .opencode/skills/).
 *
 * What it does:
 *   - tool.execute.after on write/edit tools -> records the written file
 *     (attribution + same-file-revert signal), via `loopback record-write`.
 *   - event-bus user messages                -> scans for correction-language and
 *     bumps the per-session counter, via `loopback scan-correction` +
 *     `loopback bump-correction`.
 *
 * Limitations vs Claude Code (be honest about these):
 *   - OpenCode has no turn-blocking hook (no Stop equivalent), so it cannot force
 *     the skill to run at the turn boundary. Triggering relies on the model
 *     noticing the correction in the conversation it already sees, plus the
 *     /feedback command. This plugin's bookkeeping lets the skill read richer
 *     state via the get_session_state MCP tool.
 *   - The exact event type/shape for a submitted user message varies by OpenCode
 *     version; the event handler feature-detects and never throws. VERIFY against
 *     your installed version (see README) before relying on auto-detection.
 *
 * Setup: set LOOPBACK_CLI to the absolute path of loopback/cli/index.js. (Once
 * loopback is published to npm you can instead import @loopback/core directly and
 * drop the CLI shell-out.)
 */

const WRITE_TOOLS = new Set(["write", "edit", "patch", "apply_patch", "multiedit"])

export const loopback: Plugin = async ({ $ }) => {
  // `loopback setup` patches the empty-string fallback below to bake in the
  // absolute path of loopback/cli/index.js, so the plugin works without the user
  // having to export LOOPBACK_CLI. (Env var still wins when set.)
  const CLI = process.env.LOOPBACK_CLI || ""
  const enabled = CLI.length > 0

  // Run the loopback CLI; returns its exit code (or -1 if unavailable/errored).
  // Bun's $ escapes interpolated array elements, so user text is passed safely.
  async function loop(args: string[]): Promise<number> {
    if (!enabled) return -1
    try {
      const res = await $`node ${CLI} ${args}`.nothrow().quiet()
      return res.exitCode ?? -1
    } catch {
      return -1
    }
  }

  function userText(event: any): string | undefined {
    if (!event || typeof event !== "object") return undefined
    if (!String(event.type ?? "").includes("message")) return undefined
    const p = event.properties ?? event.data ?? event
    const role = p?.role ?? p?.message?.role ?? p?.info?.role
    if (role && role !== "user") return undefined
    const part = p?.part ?? p?.message ?? p
    const text =
      part?.text ??
      (Array.isArray(part?.parts)
        ? part.parts.map((x: any) => x?.text).filter(Boolean).join(" ")
        : undefined)
    return typeof text === "string" && text.trim() ? text : undefined
  }

  function sessionId(event: any): string {
    const p = event?.properties ?? event?.data ?? event ?? {}
    return String(p.sessionID ?? p.sessionId ?? p?.message?.sessionID ?? p?.info?.sessionID ?? "default")
  }

  return {
    "tool.execute.after": async (input: any, _output: any) => {
      try {
        const tool = String(input?.tool ?? "")
        if (!WRITE_TOOLS.has(tool)) return
        const sid = String(input?.sessionID ?? input?.sessionId ?? "default")
        const file = input?.args?.filePath ?? input?.args?.path ?? input?.args?.file
        if (file) await loop(["record-write", "--session", sid, "--file", String(file)])
      } catch {
        /* best-effort; never disrupt the session */
      }
    },

    event: async ({ event }: any) => {
      try {
        const text = userText(event)
        if (!text) return
        if ((await loop(["scan-correction", text])) === 0) {
          await loop(["bump-correction", "--session", sessionId(event)])
        }
      } catch {
        /* best-effort; never disrupt the session */
      }
    },
  }
}
