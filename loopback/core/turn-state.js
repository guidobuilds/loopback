'use strict';
/*
 * turn-state (core) — disk-backed, per-session tripwire bookkeeping used by the
 * deterministic adapters (Claude Code hooks, OpenCode plugin) via the CLI.
 *
 * DETERMINISTIC ONLY: this never makes a defect-vs-iteration judgment and never
 * POSTs. It records that the agent wrote a file this turn and that the user used
 * correction-language, so the detector skill can be primed at the turn boundary.
 *
 * Extracted from the former scripts/{on-post-tooluse,on-user-prompt,on-stop};
 * now takes the resolved dataDir as a parameter, so it is harness-agnostic.
 *
 * Store: <dataDir>/turn-state/<session_id>.json
 */

const fs = require('fs');
const path = require('path');

// Correction-language tripwire phrases (precision over recall: cheap hints, not
// a verdict — the skill applies the real defect-vs-iteration filter).
const CORRECTION_MARKERS = [
  /\b(?:that'?s|that\s+is|this'?s|this\s+is|it'?s|it\s+is)\s+(?:wrong|incorrect)\b/i,
  /\b(?:that'?s|that\s+is|this'?s|this\s+is|it'?s|it\s+is)\s+(?:not|n'?t)\s+(?:right|correct|the\s+right)\b/i,
  /\b(?:this|that)\s+is(?:n'?t|\s+not)\s+the\s+right\b/i,
  /\bwrong\s+(?:format|template|structure|approach|way)\b/i,
  /\byou\s+(?:didn'?t|did\s+not|forgot\s+to|failed\s+to)\s+(?:test|run|check|follow|use|include|write)\b/i,
  /\b(?:always|stop|don'?t|do\s+not|never)\s+\w+/i,
  /\bthe\s+\w+\s+(?:template|format)\s+is\b/i,
  /\b(?:template|format)\s+is\s+\w+,?\s+not\s+\w+/i,
  /\bredo\b|\bfix\s+this\b|\b(?:that'?s|that\s+is)\s+incorrect\b/i,
  /\bundo\b|\brevert\b/i,
  /^\s*no,?\b/i,
];

function scanCorrection(text) {
  const t = String(text || '');
  return CORRECTION_MARKERS.some((re) => re.test(t));
}

function sanitize(sessionId) {
  return String(sessionId || 'default').replace(/[^\w.-]/g, '_');
}

function statePath(dataDir, sessionId) {
  return path.join(dataDir, 'turn-state', sanitize(sessionId) + '.json');
}

function readState(dataDir, sessionId) {
  if (!sessionId) return {};
  try {
    return JSON.parse(fs.readFileSync(statePath(dataDir, sessionId), 'utf8'));
  } catch (_) {
    return {};
  }
}

function writeState(dataDir, sessionId, state) {
  try {
    fs.mkdirSync(path.join(dataDir, 'turn-state'), { recursive: true });
    fs.writeFileSync(statePath(dataDir, sessionId), JSON.stringify(state));
  } catch (_) {
    /* best-effort bookkeeping; never fail the caller */
  }
}

function recordWrite(dataDir, sessionId, filePath) {
  if (!sessionId || !filePath) return;
  const state = readState(dataDir, sessionId);
  if (!Array.isArray(state.writes)) state.writes = [];
  state.writes.push({ file_path: filePath, at: new Date().toISOString() });
  state.writes = state.writes.slice(-50); // bound the file
  writeState(dataDir, sessionId, state);
}

function bumpCorrection(dataDir, sessionId) {
  if (!sessionId) return 1;
  const state = readState(dataDir, sessionId);
  state.correctionPrompts = (state.correctionPrompts || 0) + 1;
  writeState(dataDir, sessionId, state);
  return state.correctionPrompts;
}

// A candidate is "primed" once correction-language has been seen this session.
function isPrimed(state) {
  return Boolean(state && (state.correctionPrompts || 0) >= 1);
}

module.exports = {
  CORRECTION_MARKERS,
  scanCorrection,
  statePath,
  readState,
  writeState,
  recordWrite,
  bumpCorrection,
  isPrimed,
};
