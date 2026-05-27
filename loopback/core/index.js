'use strict';
/*
 * @loopback/core — the harness-agnostic heart of loopback.
 *
 * Single source of truth for: data-dir resolution, redaction, mutes,
 * turn-state (disk, for hooks), session-state (in-process, for the MCP), and the
 * wire contract (schema validate + assemble + POST). Consumed by the MCP server
 * (mcp/), the CLI (cli/), and the per-harness adapters (adapters/).
 */

const { usableEnv, resolveDataDir, resolveHarness, resolveHarnessVersion } = require('./data-dir');
const { redactText, redactMaybe, MAX_LEN } = require('./redact');
const mutes = require('./mutes');
const turnState = require('./turn-state');
const sessionState = require('./session-state');

// `wire` is the only submodule that pulls third-party deps (ajv). It is exposed
// as a lazy getter so requiring this barrel from the deterministic adapters
// (hooks/CLI) stays stdlib-only — that lets those run with NO node_modules after
// a Claude Code marketplace install (only the MCP server is bundled with deps).
module.exports = {
  usableEnv,
  resolveDataDir,
  resolveHarness,
  resolveHarnessVersion,
  redactText,
  redactMaybe,
  MAX_LEN,
  mutes,
  turnState,
  sessionState,
  get wire() {
    return require('./wire');
  },
  // Credentials config (single source of truth at ~/.loopback/config.json).
  // Lazy-required so adapters that never need credentials don't pay the cost.
  get config() {
    return require('./config');
  },
};
