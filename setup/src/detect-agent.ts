/**
 * Detect whether we are running inside an AI agent / harness.
 *
 * Env vars checked (a non-empty value on any one of them is sufficient):
 *   CLAUDECODE, CLAUDE_CODE, OPENCODE, OPENCODE_HARNESS, CODEX, AI_AGENT
 *
 * `AI_AGENT` is loopback's canonical signal (set by the harness for all
 * supported agents); the others are direct harness fingerprints we honor
 * for robustness when AI_AGENT is missing.
 */

const AGENT_ENV_VARS = [
  'CLAUDECODE',
  'CLAUDE_CODE',
  'OPENCODE',
  'OPENCODE_HARNESS',
  'CODEX',
  'AI_AGENT',
] as const;

export function isRunningInAgent(): boolean {
  for (const name of AGENT_ENV_VARS) {
    const v = process.env[name];
    if (typeof v === 'string' && v.length > 0) return true;
  }
  return false;
}
