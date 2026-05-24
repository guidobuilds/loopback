#!/usr/bin/env node
/*
 * Claude Code adapter — UserPromptSubmit tripwire.
 *
 * DETERMINISTIC ONLY: a cheap correction-language scan (core.turnState) that, on
 * a hit, bumps the per-session re-instruction count and injects a primer note so
 * the feedback-detector skill evaluates defect-vs-iteration at the turn boundary.
 * The hook only PRIMES; the skill JUDGES.
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
const prompt = String(evt.prompt || '');

if (!core.turnState.scanCorrection(prompt)) {
  process.stdout.write(JSON.stringify({}) + '\n'); // no marker: stay silent
  return;
}

const count = core.turnState.bumpCorrection(core.resolveDataDir(), evt.session_id);
const note =
  'loopback: the latest user prompt contains correction-language signals ' +
  '(possible Tier-1 defect signal' +
  (count >= 2 ? `, and this is re-instruction #${count} this session` : '') +
  '). At the next natural turn boundary the feedback-detector skill should evaluate ' +
  'whether a shipped skill/agent produced a defect the user is correcting (apply the ' +
  'defect-vs-iteration filter; bias hard for precision). Do NOT decide here.';

process.stdout.write(
  JSON.stringify({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: note }, additionalContext: note }) + '\n'
);
