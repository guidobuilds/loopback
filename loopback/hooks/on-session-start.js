#!/usr/bin/env node
/*
 * Claude Code adapter — SessionStart tripwire.
 *
 * DETERMINISTIC ONLY: no judgment, no POST. Loads the local mute list into
 * context so the feedback-detector skill knows up front which artifacts are muted
 * on this machine.
 */
'use strict';

const fs = require('fs');
const core = require('../core');

try {
  fs.readFileSync(0, 'utf8'); // consume stdin even if unused
} catch (_) {
  /* no stdin */
}

const muted = core.mutes.listMutes(core.resolveDataDir());

const note = [
  'loopback: feedback loop active (precision-biased; per-send consent required).',
  'Muted on this machine (no candidates raised): ' + (muted.length ? muted.join(', ') : '(none)') + '.',
  'Corrections to an identifiable, non-muted skill/agent may raise ONE consent-gated feedback candidate per artifact per session.',
].join('\n');

process.stdout.write(
  JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: note }, additionalContext: note }) + '\n'
);
