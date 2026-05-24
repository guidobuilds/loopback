'use strict';
/* Client test runner: core unit checks (against test/fixtures) + the MCP
 * integration smoke. Run with `npm test` (or `node test/run.js`). */

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { execFileSync } = require('child_process');

// Isolate all state in a throwaway dir so the suite never touches real state.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'loopback-test-'));
process.env.LOOPBACK_DATA_DIR = TMP;

const core = require('../core');
const FIX = path.join(__dirname, 'fixtures');

function section(name, fn) {
  fn();
  console.log('  ✓ ' + name);
}

console.log('core unit checks:');

section('redact fixtures match the wire contract', () => {
  const data = JSON.parse(fs.readFileSync(path.join(FIX, 'redact-cases.json'), 'utf8'));
  const cases = data.cases || data;
  for (const c of cases) {
    if (c.expected === undefined) continue;
    assert.strictEqual(core.redactText(c.input), c.expected, 'redact mismatch for: ' + JSON.stringify(c.input));
  }
});

section('redaction is idempotent', () => {
  const raw = fs.readFileSync(path.join(FIX, 'raw-with-pii.txt'), 'utf8');
  const once = core.redactText(raw);
  assert.strictEqual(core.redactText(once), once);
  assert.ok(!/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/.test(once), 'email survived redaction');
});

section('data-dir honors LOOPBACK_DATA_DIR', () => {
  assert.strictEqual(core.resolveDataDir(), TMP);
});

section('harness auto-detects from AI_AGENT (no config needed)', () => {
  const CLEAR = ['AI_AGENT', 'LOOPBACK_HARNESS', 'CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_PLUGIN_ROOT', 'CLAUDE_PLUGIN_DATA', 'CODEX_SANDBOX', 'CODEX_HOME'];
  const saved = {};
  for (const k of CLEAR) { saved[k] = process.env[k]; delete process.env[k]; }
  try {
    process.env.AI_AGENT = 'opencode_0-5-0_agent';
    assert.strictEqual(core.resolveHarness(), 'opencode');
    process.env.AI_AGENT = 'claude-code_2-1-150_agent';
    assert.strictEqual(core.resolveHarness(), 'claude-code');
    assert.strictEqual(core.resolveHarnessVersion(), '2.1.150');
    process.env.AI_AGENT = 'codex_0-50-0_agent';
    assert.strictEqual(core.resolveHarness(), 'codex');
    delete process.env.AI_AGENT;
    process.env.CLAUDECODE = '1';
    assert.strictEqual(core.resolveHarness(), 'claude-code'); // CC env fallback
    delete process.env.CLAUDECODE;
    assert.strictEqual(core.resolveHarness(), undefined); // unknown -> omit, never mislabel
  } finally {
    for (const k of CLEAR) { if (saved[k] !== undefined) process.env[k] = saved[k]; }
  }
});

section('mutes round-trip', () => {
  assert.strictEqual(core.mutes.isMuted(TMP, 'x'), false);
  core.mutes.mute(TMP, 'x');
  assert.strictEqual(core.mutes.isMuted(TMP, 'x'), true);
  core.mutes.unmute(TMP, 'x');
  assert.strictEqual(core.mutes.isMuted(TMP, 'x'), false);
});

section('correction scan + turn-state priming', () => {
  assert.strictEqual(core.turnState.scanCorrection('no, that is wrong'), true);
  assert.strictEqual(core.turnState.scanCorrection('also add pagination'), false);
  core.turnState.bumpCorrection(TMP, 's');
  assert.ok(core.turnState.isPrimed(core.turnState.readState(TMP, 's')));
});

section('valid fixture validates; missing-summary is rejected', () => {
  const valid = JSON.parse(fs.readFileSync(path.join(FIX, 'record.valid.json'), 'utf8'));
  assert.ok(core.wire.validateRecord(valid), JSON.stringify(core.wire.validateRecord.errors));
  const missing = JSON.parse(fs.readFileSync(path.join(FIX, 'record.missing-summary.json'), 'utf8'));
  assert.ok(!core.wire.validateRecord(missing), 'missing-summary should be rejected');
});

section('assembleRecord redacts + stamps harness and validates', () => {
  const rec = core.wire.assembleRecord(
    { artifactKind: 'skill', artifactId: 'prd-writer', summary: 'lesson', evidenceExcerpt: 'leak at /Users/x/a.ts' },
    { harness: 'opencode', pluginVersion: '0.0.1' }
  );
  assert.ok(core.wire.validateRecord(rec), JSON.stringify(core.wire.validateRecord.errors));
  assert.strictEqual(rec.client.harness, 'opencode');
  assert.ok(!/\/Users\//.test(rec.evidenceExcerpt));
  // Identity is resolved server-side from the auth token; no anonUserId on the wire.
  assert.ok(!('anonUserId' in rec), 'anonUserId must not be stamped');
});

console.log('\nMCP integration smoke:');
execFileSync('node', [path.join(__dirname, 'mcp-smoke.js')], { stdio: 'inherit', env: process.env });

console.log('\nALL CLIENT TESTS PASSED');
