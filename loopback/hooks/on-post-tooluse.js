#!/usr/bin/env node
/*
 * Claude Code adapter — PostToolUse tripwire (Write|Edit).
 *
 * DETERMINISTIC ONLY: no judgment, no POST. Records that the agent wrote a file
 * this turn (for attribution + revert tracking) and injects a primer note so the
 * feedback-detector skill knows which artifact path was just produced. All logic
 * lives in @loopback/core; this file is only the harness-specific glue (stdin
 * event shape + hook output shape).
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
const filePath = evt.tool_input && evt.tool_input.file_path;
const tool = evt.tool_name || 'Write/Edit';

core.turnState.recordWrite(core.resolveDataDir(), evt.session_id, filePath);

const note =
  'loopback: the agent just used ' +
  tool +
  (filePath ? ' on a file this turn' : '') +
  '. If the user corrects or reverts this output later in the turn, the ' +
  'feedback-detector skill may consider it a candidate defect (do NOT judge here).';

process.stdout.write(
  JSON.stringify({ hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: note }, additionalContext: note }) + '\n'
);
