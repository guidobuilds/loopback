'use strict';
/*
 * data-dir (core) — harness-agnostic resolution of the mutable per-machine
 * state dir (mutes.json, turn-state/).
 *
 * Each adapter MAY set LOOPBACK_DATA_DIR to pin the location; otherwise we
 * resolve a sensible per-harness default and fall back to XDG so the same core
 * works under Claude Code, OpenCode, and Codex.
 */

const os = require('os');
const path = require('path');

// An injected env var is only usable if the harness actually substituted it.
// Some harnesses (e.g. Claude Code 2.1.x) do NOT expand ${...} inside MCP `env`
// values, so a value can arrive as the literal template "${CLAUDE_PLUGIN_DATA}".
// Treat empty OR unsubstituted ("${...") values as UNSET so we fall back.
function usableEnv(name) {
  const v = process.env[name];
  if (!v || v.length === 0) return undefined;
  if (v.includes('${')) return undefined; // unsubstituted template -> not usable
  return v;
}

// Resolve the data dir. Priority:
//   1. LOOPBACK_DATA_DIR        — explicit override (adapters / tests set this)
//   2. CLAUDE_PLUGIN_DATA       — Claude Code, when actually substituted
//   3. ~/.claude/.../loopback   — Claude Code fallback (running as a CC plugin)
//   4. $XDG_DATA_HOME/loopback  — generic XDG
//   5. ~/.local/share/loopback  — generic default
function resolveDataDir() {
  const explicit = usableEnv('LOOPBACK_DATA_DIR');
  if (explicit) return explicit;

  const cc = usableEnv('CLAUDE_PLUGIN_DATA');
  if (cc) return cc;
  if (usableEnv('CLAUDE_PLUGIN_ROOT')) {
    // Running as a Claude Code plugin but the data var was not substituted;
    // mirror Claude Code's documented per-plugin data path.
    return path.join(os.homedir(), '.claude', 'plugins', 'data', 'loopback');
  }

  const xdg = usableEnv('XDG_DATA_HOME');
  if (xdg) return path.join(xdg, 'loopback');
  return path.join(os.homedir(), '.local', 'share', 'loopback');
}

// Which harness produced this submission, for telemetry (client.harness).
//
// AGNOSTIC BY DESIGN: nothing is configured per harness. The MCP server inherits
// the launching harness's environment, which advertises the harness itself — so
// we detect it at runtime. Primary signal is the cross-tool `AI_AGENT` var
// (format "<harness>_<version>_<mode>", e.g. "claude-code_2-1-150_agent"); then
// harness-specific env markers. Returns undefined when unknown so we omit the
// field rather than mislabel it. LOOPBACK_HARNESS stays honored as an undocumented
// override but is never written into any config.
function resolveHarness() {
  const explicit = usableEnv('LOOPBACK_HARNESS');
  if (explicit) return explicit;

  const ai = (usableEnv('AI_AGENT') || '').toLowerCase();
  if (ai.startsWith('claude-code') || ai.startsWith('claude')) return 'claude-code';
  if (ai.startsWith('opencode')) return 'opencode';
  if (ai.startsWith('codex')) return 'codex';

  // Harness-specific fallbacks for runtimes that don't (yet) set AI_AGENT.
  if (usableEnv('CLAUDECODE') || usableEnv('CLAUDE_CODE_ENTRYPOINT') || usableEnv('CLAUDE_PLUGIN_ROOT') || usableEnv('CLAUDE_PLUGIN_DATA')) {
    return 'claude-code';
  }
  if (usableEnv('CODEX_SANDBOX') || usableEnv('CODEX_HOME')) return 'codex';

  return undefined;
}

// The harness version, if the runtime advertises one via AI_AGENT
// ("claude-code_2-1-150_agent" -> "2.1.150"). Best-effort; undefined when absent.
function resolveHarnessVersion() {
  const ai = usableEnv('AI_AGENT');
  if (!ai) return undefined;
  const parts = ai.split('_');
  if (parts.length < 2) return undefined;
  const v = parts[1].replace(/-/g, '.');
  return /^[0-9].*/.test(v) ? v : undefined;
}

module.exports = { usableEnv, resolveDataDir, resolveHarness, resolveHarnessVersion };
