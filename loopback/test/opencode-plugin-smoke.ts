/* OpenCode plugin smoke (run with: bun test/opencode-plugin-smoke.ts).
 * Drives the plugin's hooks with Bun's real $ so plugin -> loopback CLI -> core
 * runs for real, then asserts the shared turn-state was primed. */
import { $ } from "bun"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import assert from "assert"
import { loopback } from "../adapters/opencode/plugins/loopback.ts"

const ROOT = path.resolve(import.meta.dir, "..")
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "oc-"))
process.env.LOOPBACK_DATA_DIR = tmp
process.env.LOOPBACK_CLI = path.join(ROOT, "cli", "index.js")

const hooks: any = await loopback({ $ } as any)

// 1) a write tool call is recorded for attribution.
await hooks["tool.execute.after"](
  { tool: "write", sessionID: "oc1", args: { filePath: "/Users/x/a.ts" } },
  {}
)

// 2) a user message with correction-language bumps the per-session counter.
await hooks["event"]({
  event: {
    type: "message.updated",
    properties: { role: "user", message: { sessionID: "oc1", text: "no, that is the wrong format" } },
  },
})

// 3) a non-correction user message does NOT bump.
await hooks["event"]({
  event: {
    type: "message.updated",
    properties: { role: "user", message: { sessionID: "oc1", text: "also add pagination please" } },
  },
})

const core = require(path.join(ROOT, "core"))
const st = core.turnState.readState(tmp, "oc1")
console.log("turn-state:", JSON.stringify(st))

assert.ok(Array.isArray(st.writes) && st.writes.some((w: any) => w.file_path === "/Users/x/a.ts"), "write not recorded")
assert.strictEqual(st.correctionPrompts, 1, "expected exactly one correction bump")
assert.ok(core.turnState.isPrimed(st), "session should be primed")

console.log("\nOPENCODE PLUGIN SMOKE OK")
