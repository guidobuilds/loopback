#!/usr/bin/env node
/*
 * Claude Code adapter — Stop tripwire (turn boundary).
 *
 * DETERMINISTIC ONLY: no judgment, no POST. If a candidate was primed this turn
 * (correction-language seen), it returns decision:"block" so the turn stays alive
 * for the feedback-detector skill to run its judgment + consent gate. A loop
 * guard (stop_hook_active) prevents re-blocking.
 */
'use strict';

const fs = require('fs');
const core = require('../core');

function readStdinJson() {
  try {
    return JSON.parse(fs.readFileSync(0, 'utf8') || '{}');
  } catch (_) {
    return {};
  }
}

const evt = readStdinJson();
const state = core.turnState.readState(core.resolveDataDir(), evt.session_id);
const primed = core.turnState.isPrimed(state);
const alreadyActive = evt.stop_hook_active === true;

if (!primed || alreadyActive) {
  process.stdout.write(JSON.stringify({}) + '\n'); // let the turn end quietly
  return;
}

const reason =
  'loopback: a possible skill/agent defect was primed this turn ' +
  '(correction-language and/or a corrected file). Before ending, invoke the ' +
  'feedback-detector skill to evaluate the candidate: require >=1 Tier-1 signal, ' +
  'apply the defect-vs-iteration filter, enforce the attribution + mute gates, and ' +
  'if it clears, render the consent gate ("send feedback to the owner?"). If it does ' +
  'not clear, end normally.';

process.stdout.write(
  JSON.stringify({
    decision: 'block',
    reason,
    hookSpecificOutput: { hookEventName: 'Stop', additionalContext: reason },
  }) + '\n'
);
