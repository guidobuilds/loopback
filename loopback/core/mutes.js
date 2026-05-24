'use strict';
/*
 * mutes (core) — per-artifact local mute list (A4).
 *
 * Backs the "[N]ever for this skill" consent-gate action: a local mute in
 * <dataDir>/mutes.json so the detector stops raising candidates for that
 * artifact on this machine. Local-only; survives updates.
 *
 * Extracted from the former scripts/mute; now takes the resolved dataDir as a
 * parameter, so it is harness-agnostic.
 *
 * Store: <dataDir>/mutes.json -> { "schemaVersion": 1, "muted": [ids] }
 */

const fs = require('fs');
const path = require('path');

function mutesPath(dataDir) {
  return path.join(dataDir, 'mutes.json');
}

function readMutes(dataDir) {
  try {
    const data = JSON.parse(fs.readFileSync(mutesPath(dataDir), 'utf8'));
    if (Array.isArray(data.muted)) return data;
  } catch (_) {
    /* not yet created or unreadable -> start fresh */
  }
  return { schemaVersion: 1, muted: [] };
}

function writeMutes(dataDir, state) {
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(mutesPath(dataDir), JSON.stringify(state, null, 2) + '\n', { mode: 0o600 });
}

function isMuted(dataDir, id) {
  return readMutes(dataDir).muted.includes(id);
}

function mute(dataDir, id) {
  const state = readMutes(dataDir);
  if (!state.muted.includes(id)) {
    state.muted.push(id);
    writeMutes(dataDir, state);
  }
  return true;
}

function unmute(dataDir, id) {
  const state = readMutes(dataDir);
  state.muted = state.muted.filter((m) => m !== id);
  writeMutes(dataDir, state);
}

function listMutes(dataDir) {
  return readMutes(dataDir).muted;
}

module.exports = { isMuted, mute, unmute, listMutes, readMutes };
