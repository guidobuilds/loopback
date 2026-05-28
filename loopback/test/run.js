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

// core/config.js — single source of truth for LOOPBACK_SERVICE_URL/_TOKEN at
// ~/.loopback/config.json. Tests run against a throwaway HOME so the real
// ~/.loopback is never touched. Each test isolates HOME + env to avoid cross-
// contamination from the suite-level env (process.env).
section('core/config: precedence flag > env > file > undefined', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'lb-cfg-'));
  const savedHome = process.env.HOME;
  const savedUrl = process.env.LOOPBACK_SERVICE_URL;
  const savedTok = process.env.LOOPBACK_TOKEN;
  process.env.HOME = home;
  delete process.env.LOOPBACK_SERVICE_URL;
  delete process.env.LOOPBACK_TOKEN;
  try {
    // Layer 4: nothing set anywhere -> undefined fields.
    let r = core.config.resolveCredentials({});
    assert.strictEqual(r.serviceUrl, undefined, 'no source -> undefined url');
    assert.strictEqual(r.token, undefined, 'no source -> undefined token');

    // Layer 3: file only.
    core.config.saveConfig({ serviceUrl: 'http://file', token: 'tok-file' });
    r = core.config.resolveCredentials({});
    assert.strictEqual(r.serviceUrl, 'http://file');
    assert.strictEqual(r.token, 'tok-file');

    // Layer 2: env beats file.
    process.env.LOOPBACK_SERVICE_URL = 'http://env';
    process.env.LOOPBACK_TOKEN = 'tok-env';
    r = core.config.resolveCredentials({});
    assert.strictEqual(r.serviceUrl, 'http://env');
    assert.strictEqual(r.token, 'tok-env');

    // Layer 1: flag beats env.
    r = core.config.resolveCredentials({ flagUrl: 'http://flag', flagToken: 'tok-flag' });
    assert.strictEqual(r.serviceUrl, 'http://flag');
    assert.strictEqual(r.token, 'tok-flag');
  } finally {
    process.env.HOME = savedHome;
    if (savedUrl !== undefined) process.env.LOOPBACK_SERVICE_URL = savedUrl; else delete process.env.LOOPBACK_SERVICE_URL;
    if (savedTok !== undefined) process.env.LOOPBACK_TOKEN = savedTok; else delete process.env.LOOPBACK_TOKEN;
  }
});

section('core/config: saveConfig writes with mode 0600', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'lb-cfg-'));
  const savedHome = process.env.HOME;
  process.env.HOME = home;
  try {
    core.config.saveConfig({ serviceUrl: 'http://x', token: 'tok' });
    const p = core.config.configPath();
    assert.ok(fs.existsSync(p), 'config file exists');
    if (process.platform !== 'win32') {
      const mode = fs.statSync(p).mode & 0o777;
      assert.strictEqual(mode, 0o600, 'config.json mode: ' + mode.toString(8));
    }
    const loaded = core.config.loadConfig();
    assert.strictEqual(loaded.serviceUrl, 'http://x');
    assert.strictEqual(loaded.token, 'tok');
    assert.strictEqual(loaded.schemaVersion, 2);
  } finally {
    process.env.HOME = savedHome;
  }
});

// Whitelist-write: saveConfig drops every key that is not part of the canonical
// schema (`schemaVersion`, `serviceUrl`, `token`). Pre-existing files carrying
// arbitrary cruft are sanitized on the next save.
section('core/config: saveConfig is a strict whitelist (drops unknown keys)', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'lb-cfg-'));
  const savedHome = process.env.HOME;
  process.env.HOME = home;
  try {
    fs.mkdirSync(path.join(home, '.loopback'), { recursive: true });
    fs.writeFileSync(
      path.join(home, '.loopback', 'config.json'),
      JSON.stringify({ schemaVersion: 2, serviceUrl: 'http://existing', token: 'EXISTING', randomCruft: 'y' })
    );
    core.config.saveConfig({ serviceUrl: 'http://new', token: 'NEW' });
    const raw = fs.readFileSync(path.join(home, '.loopback', 'config.json'), 'utf8');
    const parsed = JSON.parse(raw);
    assert.deepStrictEqual(
      Object.keys(parsed).sort(),
      ['schemaVersion', 'serviceUrl', 'token'].sort(),
      'on-disk keys must be exactly the canonical whitelist'
    );
    assert.strictEqual(parsed.schemaVersion, 2);
    assert.strictEqual(parsed.serviceUrl, 'http://new');
    assert.strictEqual(parsed.token, 'NEW');
    assert.strictEqual(parsed.randomCruft, undefined, 'no unknown keys on disk');
  } finally {
    process.env.HOME = savedHome;
  }
});

// endpoint() — base + path -> concrete URL. Strips trailing slashes from the
// base, prepends `/` to path if absent, returns null for missing/empty base.
section('core/wire.endpoint composes service URL + path', () => {
  assert.strictEqual(core.wire.endpoint('http://x', '/feedback'), 'http://x/feedback');
  assert.strictEqual(core.wire.endpoint('http://x/', '/feedback'), 'http://x/feedback');
  assert.strictEqual(core.wire.endpoint('http://x///', '/feedback'), 'http://x/feedback');
  assert.strictEqual(core.wire.endpoint('http://x', 'feedback'), 'http://x/feedback');
  assert.strictEqual(core.wire.endpoint(undefined, '/feedback'), null);
  assert.strictEqual(core.wire.endpoint('', '/feedback'), null);
});

section('core/config: loadConfig graceful on missing/invalid', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'lb-cfg-'));
  const savedHome = process.env.HOME;
  process.env.HOME = home;
  try {
    // Missing file -> {}.
    assert.deepStrictEqual(core.config.loadConfig(), {});

    // Invalid JSON -> {} (does NOT throw).
    fs.mkdirSync(path.join(home, '.loopback'), { recursive: true });
    fs.writeFileSync(path.join(home, '.loopback', 'config.json'), '{ not-json');
    assert.deepStrictEqual(core.config.loadConfig(), {});

    // Non-object JSON (array) -> {}.
    fs.writeFileSync(path.join(home, '.loopback', 'config.json'), '[1,2,3]');
    // Arrays are typeof 'object' — but the schema check in loadConfig accepts
    // any object, so the right invariant here is that it does not throw. We
    // still want non-string fields to be ignored downstream.
    const v = core.config.loadConfig();
    assert.strictEqual(typeof v, 'object');
  } finally {
    process.env.HOME = savedHome;
  }
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

// `loopback feedback list` read path (async: flag->query mapping, table/json
// renderers, and fetchRecords against a throwaway HTTP server). Runs before the
// MCP smoke.
require('./feedback').run().then(() => {
  console.log('\nMCP integration smoke:');
  execFileSync('node', [path.join(__dirname, 'mcp-smoke.js')], { stdio: 'inherit', env: process.env });

  console.log('\nALL CLIENT TESTS PASSED');
}).catch((e) => {
  console.error(e);
  process.exit(1);
});
