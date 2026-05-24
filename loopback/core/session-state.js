'use strict';
/*
 * session-state (core) — in-process per-session state for the MCP server.
 *
 * The MCP server runs as one stdio process per session, so module-level state is
 * naturally session-scoped. The detector skill uses this (via the record_signal
 * and get_session_state tools) to debounce: "one candidate per artifact per
 * session". This is the harness-agnostic replacement for relying on hook-injected
 * context, which not every harness provides.
 */

const _signals = [];
const _raised = new Set();

// Record a Tier-1 signal observed this session (correction | revert | reinstruct).
function recordSignal(sig) {
  const entry = Object.assign({ at: new Date().toISOString() }, sig || {});
  _signals.push(entry);
  if (_signals.length > 200) _signals.splice(0, _signals.length - 200);
  return entry;
}

// Mark that a consent candidate was already surfaced for this artifact.
function markRaised(artifactId) {
  if (artifactId) _raised.add(artifactId);
}

function hasRaised(artifactId) {
  return Boolean(artifactId) && _raised.has(artifactId);
}

function getState() {
  return {
    signals: _signals.slice(),
    raised: Array.from(_raised),
    correctionCount: _signals.filter((s) => s.type === 'correction').length,
  };
}

// Test helper.
function _reset() {
  _signals.length = 0;
  _raised.clear();
}

module.exports = { recordSignal, markRaised, hasRaised, getState, _reset };
