'use strict';
/* Installer smoke: drive `loopback auth` and `loopback setup <harness>`
 * against a throwaway HOME and assert each harness gets correct, idempotent
 * config + assets. Never touches the real HOME.
 *
 * Invariants asserted here:
 *   1. NO `env`/`environment` blocks for LOOPBACK_* are written by setup.
 *   2. `loopback auth` writes ~/.loopback/config.json at 0600 with the
 *      canonical schema { schemaVersion: 2, serviceUrl, token }.
 *   3. `loopback setup <harness>` exits 1 with an actionable message when
 *      ~/.loopback/config.json is missing (no creds).
 *   4. The per-harness installers are idempotent and preserve unrelated user
 *      config (e.g. other MCP servers, unrelated hooks).
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { spawnSync } = require('child_process');

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'lb-home-'));
process.env.HOME = tmpHome;
delete process.env.XDG_CONFIG_HOME;
// The resolver and the installer also honor LOOPBACK_* env vars. Clear them so
// this suite tests the file-only path deterministically.
delete process.env.LOOPBACK_SERVICE_URL;
delete process.env.LOOPBACK_TOKEN;

const setup = require('../cli/setup');
const core = require('../core');

const BUNDLE = path.resolve(__dirname, '..', 'mcp', 'server.bundle.js');
const CLI = path.resolve(__dirname, '..', 'cli', 'index.js');

function read(p) {
  return fs.readFileSync(p, 'utf8');
}
function exists(p) {
  try {
    fs.accessSync(p);
    return true;
  } catch (_) {
    return false;
  }
}

// Seed credentials so the direct installer calls below pass requireAuth.
core.config.saveConfig({ serviceUrl: 'http://svc.local', token: 'lpbk_test' });

/* ── OpenCode ── */
setup.installOpenCode();
const ocPath = path.join(tmpHome, '.config', 'opencode', 'opencode.json');
const oc = JSON.parse(read(ocPath));
assert.deepStrictEqual(oc.mcp.loopback.command, ['node', BUNDLE], 'opencode MCP command');
assert.strictEqual(oc.mcp.loopback.type, 'local');
// No `environment` block at all (no LOOPBACK_* and no other survivors).
assert.strictEqual(oc.mcp.loopback.environment, undefined, 'opencode: no environment block written');
const ocPlugin = read(path.join(tmpHome, '.config', 'opencode', 'plugins', 'loopback.ts'));
assert.ok(ocPlugin.includes(`process.env.LOOPBACK_CLI || ${JSON.stringify(CLI)}`), 'opencode plugin baked CLI path');
assert.ok(exists(path.join(tmpHome, '.config', 'opencode', 'skills', 'feedback-detector', 'SKILL.md')), 'opencode skill');
assert.ok(exists(path.join(tmpHome, '.config', 'opencode', 'commands', 'harness-feedback.md')), 'opencode command');
console.log('✓ opencode: MCP + plugin(baked) + skill + command (no env block)');

// preserves unrelated config + idempotent
fs.writeFileSync(ocPath, JSON.stringify({ theme: 'dark', mcp: { other: { type: 'local', command: ['x'] } } }, null, 2));
setup.installOpenCode();
const oc2 = JSON.parse(read(ocPath));
assert.strictEqual(oc2.theme, 'dark', 'preserved unrelated key');
assert.ok(oc2.mcp.other, 'preserved other MCP server');
assert.ok(oc2.mcp.loopback, 'added loopback alongside');
console.log('✓ opencode: idempotent + preserves existing config');

// Preserves the user's env block verbatim across re-runs (no filtering).
fs.writeFileSync(
  ocPath,
  JSON.stringify(
    { mcp: { loopback: { type: 'local', command: ['old'], environment: { MY_PROXY: 'http://p' } } } },
    null,
    2
  )
);
setup.installOpenCode();
const oc3 = JSON.parse(read(ocPath));
assert.deepStrictEqual(oc3.mcp.loopback.environment, { MY_PROXY: 'http://p' }, 'opencode: user env block preserved verbatim');
console.log('✓ opencode: preserves user env block across re-runs');

/* ── Codex ── */
setup.installCodex();
const codexCfg = path.join(tmpHome, '.codex', 'config.toml');
let toml = read(codexCfg);
assert.ok(toml.includes('[mcp_servers.loopback]'), 'codex MCP block');
assert.ok(toml.includes(JSON.stringify(BUNDLE)), 'codex bundle path');
// No LOOPBACK_* env keys in the TOML.
assert.ok(!/LOOPBACK_TOKEN\s*=/.test(toml), 'codex: no LOOPBACK_TOKEN in TOML');
assert.ok(!/LOOPBACK_SERVICE_URL\s*=/.test(toml), 'codex: no LOOPBACK_SERVICE_URL in TOML');
assert.ok(exists(path.join(tmpHome, '.agents', 'skills', 'feedback-detector', 'SKILL.md')), 'codex skill');
assert.ok(exists(path.join(tmpHome, '.codex', 'prompts', 'harness-feedback.md')), 'codex prompt');
setup.installCodex(); // idempotent
toml = read(codexCfg);
assert.strictEqual(toml.match(/\[mcp_servers\.loopback\]/g).length, 1, 'codex block not duplicated');
console.log('✓ codex: MCP(toml) + skill + prompt + idempotent (no env block)');

/* ── Claude Code (file parts; force claude CLI "absent" via empty PATH) ── */
const savedPath = process.env.PATH;
process.env.PATH = '';
setup.installClaudeCode({ automaticFeedbackDetection: true });
const ccSettings = path.join(tmpHome, '.claude', 'settings.json');
let s = JSON.parse(read(ccSettings));
for (const ev of ['PostToolUse', 'UserPromptSubmit', 'Stop', 'SessionStart']) {
  assert.ok(s.hooks[ev] && s.hooks[ev].length >= 1, 'hook ' + ev);
}
assert.ok(exists(path.join(tmpHome, '.claude', 'skills', 'feedback-detector', 'SKILL.md')), 'cc skill');
assert.ok(exists(path.join(tmpHome, '.claude', 'commands', 'harness-feedback.md')), 'cc command');
// preserve an existing unrelated hook + idempotency
s = JSON.parse(read(ccSettings));
s.hooks.PreToolUse = [{ hooks: [{ type: 'command', command: 'echo keep' }] }];
fs.writeFileSync(ccSettings, JSON.stringify(s, null, 2));
setup.installClaudeCode({ automaticFeedbackDetection: true });
process.env.PATH = savedPath;
const s2 = JSON.parse(read(ccSettings));
assert.ok(s2.hooks.PreToolUse, 'preserved unrelated hook');
assert.strictEqual(s2.hooks.Stop.length, 1, 'Stop hook not duplicated on re-run');
console.log('✓ claude-code: hooks merge + skill + command + idempotent + preserves existing hooks');

/* ── Claude Code: hooks are opt-in (no flag => no hook entries) ── */
const noHookHome = fs.mkdtempSync(path.join(os.tmpdir(), 'lb-home-nohook-'));
process.env.HOME = noHookHome;
delete process.env.XDG_CONFIG_HOME;
// Re-seed creds for the new HOME.
core.config.saveConfig({ serviceUrl: 'http://svc.local', token: 'lpbk_test' });
const savedPathNH = process.env.PATH;
process.env.PATH = '';
const noHookResult = setup.installClaudeCode();
process.env.PATH = savedPathNH;
const noHookSettings = path.join(noHookHome, '.claude', 'settings.json');
if (exists(noHookSettings)) {
  const ns = JSON.parse(read(noHookSettings));
  const hookEvents = ns.hooks ? Object.keys(ns.hooks) : [];
  for (const ev of hookEvents) {
    const entries = ns.hooks[ev] || [];
    for (const entry of entries) {
      for (const x of entry.hooks || []) {
        assert.ok(
          !/loopback[\/\\]hooks[\/\\]/.test(String(x.command || '')),
          'no-flag run must not write loopback hook command: ' + x.command
        );
      }
    }
  }
}
assert.ok(
  noHookResult.actions.some((a) => /skipped hook installation/.test(a)),
  'no-flag run reports skipped hook installation in actions'
);
// Skill + command still get installed (only hooks are gated).
assert.ok(exists(path.join(noHookHome, '.claude', 'skills', 'feedback-detector', 'SKILL.md')), 'no-flag run still copies cc skill');
assert.ok(exists(path.join(noHookHome, '.claude', 'commands', 'harness-feedback.md')), 'no-flag run still copies cc command');
// Restore HOME for subsequent tests.
process.env.HOME = tmpHome;
console.log('✓ claude-code: hooks are opt-in — default install skips them');

/* ── installHarness without auth -> NO_AUTH error ── */
const noAuthHome = fs.mkdtempSync(path.join(os.tmpdir(), 'lb-home-noauth-'));
process.env.HOME = noAuthHome;
delete process.env.XDG_CONFIG_HOME;
let threw = false;
try {
  setup.installHarness('claude-code', {});
} catch (e) {
  threw = true;
  assert.strictEqual(e.code, 'NO_AUTH', 'NO_AUTH error code');
  assert.ok(/loopback auth/.test(e.message), 'error message points to `loopback auth`');
}
assert.ok(threw, 'installHarness without auth must throw');
console.log('✓ installHarness: requires auth before doing anything');

/* ── CLI: `loopback auth` writes ~/.loopback/config.json @ 0600 ── */
const authHome = fs.mkdtempSync(path.join(os.tmpdir(), 'lb-home-auth-'));
const authEnv = Object.assign({}, process.env, { HOME: authHome, PATH: '' });
delete authEnv.XDG_CONFIG_HOME;
delete authEnv.LOOPBACK_SERVICE_URL;
delete authEnv.LOOPBACK_TOKEN;
const authRes = spawnSync(
  process.execPath,
  [CLI, 'auth', '--service-url', 'http://test/', '--token', 'lpbk_TESTTOK_1234'],
  { env: authEnv, encoding: 'utf8' }
);
assert.strictEqual(authRes.status, 0, 'CLI exit 0 for auth; stderr=' + authRes.stderr);
const authCfgPath = path.join(authHome, '.loopback', 'config.json');
assert.ok(exists(authCfgPath), 'CLI auth: ~/.loopback/config.json written');
const authCfg = JSON.parse(read(authCfgPath));
assert.strictEqual(authCfg.serviceUrl, 'http://test/', 'CLI auth: serviceUrl preserved as given');
assert.strictEqual(authCfg.token, 'lpbk_TESTTOK_1234', 'CLI auth: token');
assert.strictEqual(authCfg.schemaVersion, 2, 'CLI auth: schemaVersion');
if (process.platform !== 'win32') {
  const m = fs.statSync(authCfgPath).mode & 0o777;
  assert.strictEqual(m, 0o600, 'CLI auth: mode 0600: ' + m.toString(8));
}
console.log('✓ CLI: `loopback auth` writes config.json @ 0600 with canonical schema');

/* ── CLI: `loopback auth --show` prints redacted token + path ── */
const showRes = spawnSync(process.execPath, [CLI, 'auth', '--show'], { env: authEnv, encoding: 'utf8' });
assert.strictEqual(showRes.status, 0, 'CLI exit 0 for auth --show; stderr=' + showRes.stderr);
const showJson = JSON.parse(showRes.stdout);
assert.strictEqual(showJson.serviceUrl, 'http://test/', 'show: serviceUrl');
assert.ok(/^lpbk\*+$/.test(showJson.token), 'show: token is redacted (got ' + showJson.token + ')');
assert.strictEqual(showJson.schemaVersion, 2);
assert.ok(showJson.path.endsWith(path.join('.loopback', 'config.json')), 'show: path is config.json');
console.log('✓ CLI: `loopback auth --show` prints redacted token + path');

/* ── CLI: `loopback auth --token …` rotates token, preserves serviceUrl ── */
const rotRes = spawnSync(process.execPath, [CLI, 'auth', '--token', 'NEWTOK'], { env: authEnv, encoding: 'utf8' });
assert.strictEqual(rotRes.status, 0, 'CLI exit 0 for token rotation; stderr=' + rotRes.stderr);
const rotated = JSON.parse(read(authCfgPath));
assert.strictEqual(rotated.serviceUrl, 'http://test/', 'rotation preserves serviceUrl');
assert.strictEqual(rotated.token, 'NEWTOK', 'rotation updates token');
console.log('✓ CLI: `loopback auth --token …` rotates token, preserves serviceUrl');

/* ── CLI: `loopback setup claude-code` without auth -> exit 1 ── */
const noAuthCliHome = fs.mkdtempSync(path.join(os.tmpdir(), 'lb-home-cli-noauth-'));
const noAuthCliEnv = Object.assign({}, process.env, { HOME: noAuthCliHome, PATH: '' });
delete noAuthCliEnv.XDG_CONFIG_HOME;
delete noAuthCliEnv.LOOPBACK_SERVICE_URL;
delete noAuthCliEnv.LOOPBACK_TOKEN;
const noAuthSetupRes = spawnSync(
  process.execPath,
  [CLI, 'setup', 'claude-code'],
  { env: noAuthCliEnv, encoding: 'utf8' }
);
assert.strictEqual(noAuthSetupRes.status, 1, 'CLI exit 1 for setup without auth');
assert.ok(/loopback auth/.test(noAuthSetupRes.stderr), 'CLI: stderr points to `loopback auth`');
console.log('✓ CLI: `loopback setup <harness>` without auth exits 1 with actionable message');

/* ── CLI: full happy-path — auth then setup all three harnesses ── */
const happyHome = fs.mkdtempSync(path.join(os.tmpdir(), 'lb-home-happy-'));
const happyEnv = Object.assign({}, process.env, { HOME: happyHome, PATH: '' });
delete happyEnv.XDG_CONFIG_HOME;
delete happyEnv.LOOPBACK_SERVICE_URL;
delete happyEnv.LOOPBACK_TOKEN;
let r = spawnSync(process.execPath, [CLI, 'auth', '--service-url', 'http://x', '--token', 't'], { env: happyEnv, encoding: 'utf8' });
assert.strictEqual(r.status, 0, 'happy: auth; stderr=' + r.stderr);
for (const h of ['claude-code', 'opencode', 'codex']) {
  r = spawnSync(process.execPath, [CLI, 'setup', h], { env: happyEnv, encoding: 'utf8' });
  assert.strictEqual(r.status, 0, 'happy: setup ' + h + '; stderr=' + r.stderr);
}
// Cross-check: no LOOPBACK_* env blocks anywhere in the harness configs.
const hOcPath = path.join(happyHome, '.config', 'opencode', 'opencode.json');
if (exists(hOcPath)) {
  const hOc = JSON.parse(read(hOcPath));
  assert.strictEqual(hOc.mcp.loopback.environment, undefined, 'happy opencode: no environment block');
}
const hCxPath = path.join(happyHome, '.codex', 'config.toml');
if (exists(hCxPath)) {
  assert.ok(!/LOOPBACK_/.test(read(hCxPath)), 'happy codex: no LOOPBACK_* in TOML');
}
console.log('✓ CLI: `auth` then `setup <harness>` x3 works end-to-end');

/* ── CLI: `loopback setup claude-code --automatic-feedback-detection` wires hooks ── */
const flagHome = fs.mkdtempSync(path.join(os.tmpdir(), 'lb-home-cli-flag-'));
const flagEnv = Object.assign({}, process.env, { HOME: flagHome, PATH: '' });
delete flagEnv.XDG_CONFIG_HOME;
delete flagEnv.LOOPBACK_SERVICE_URL;
delete flagEnv.LOOPBACK_TOKEN;
r = spawnSync(process.execPath, [CLI, 'auth', '--service-url', 'http://x', '--token', 't'], { env: flagEnv, encoding: 'utf8' });
assert.strictEqual(r.status, 0);
// 1. no flag => no loopback hook command strings.
r = spawnSync(process.execPath, [CLI, 'setup', 'claude-code'], { env: flagEnv, encoding: 'utf8' });
assert.strictEqual(r.status, 0, 'flag-off setup; stderr=' + r.stderr);
assert.ok(/skipped hook installation/.test(r.stdout), 'flag-off stdout mentions skipped hook installation');
const flagSettings = path.join(flagHome, '.claude', 'settings.json');
if (exists(flagSettings)) {
  const sNo = JSON.parse(read(flagSettings));
  for (const ev of Object.keys(sNo.hooks || {})) {
    for (const entry of sNo.hooks[ev] || []) {
      for (const x of entry.hooks || []) {
        assert.ok(
          !/loopback[\/\\]hooks[\/\\]/.test(String(x.command || '')),
          'flag-off run must not write loopback hook command: ' + x.command
        );
      }
    }
  }
}
// 2. with flag => 4 hook entries materialize.
r = spawnSync(
  process.execPath,
  [CLI, 'setup', 'claude-code', '--automatic-feedback-detection'],
  { env: flagEnv, encoding: 'utf8' }
);
assert.strictEqual(r.status, 0, 'flag-on setup; stderr=' + r.stderr);
const sYes = JSON.parse(read(flagSettings));
for (const ev of ['PostToolUse', 'UserPromptSubmit', 'Stop', 'SessionStart']) {
  const hits = (sYes.hooks[ev] || []).filter((entry) =>
    (entry.hooks || []).some((x) => /loopback[\/\\]hooks[\/\\]/.test(String(x.command || '')))
  );
  assert.strictEqual(hits.length, 1, 'flag-on wires hook ' + ev);
}
// 3. re-run with flag => still 1 entry per event (idempotent).
r = spawnSync(
  process.execPath,
  [CLI, 'setup', 'claude-code', '--automatic-feedback-detection'],
  { env: flagEnv, encoding: 'utf8' }
);
assert.strictEqual(r.status, 0);
const sYes2 = JSON.parse(read(flagSettings));
for (const ev of ['PostToolUse', 'UserPromptSubmit', 'Stop', 'SessionStart']) {
  const hits = (sYes2.hooks[ev] || []).filter((entry) =>
    (entry.hooks || []).some((x) => /loopback[\/\\]hooks[\/\\]/.test(String(x.command || '')))
  );
  assert.strictEqual(hits.length, 1, 'flag-on re-run keeps a single loopback hook for ' + ev);
}
console.log('✓ CLI: --automatic-feedback-detection is opt-in + idempotent');

/* ── CLI: feedback list rejects --service-url / --token (strict parser) ── */
r = spawnSync(
  process.execPath,
  [CLI, 'feedback', 'list', '--service-url', 'http://x'],
  { env: flagEnv, encoding: 'utf8' }
);
assert.notStrictEqual(r.status, 0, 'feedback list --service-url must be rejected');
assert.ok(/Unknown option|service-url/.test(r.stderr), 'stderr mentions unknown flag: ' + r.stderr);
r = spawnSync(
  process.execPath,
  [CLI, 'feedback', 'list', '--token', 'x'],
  { env: flagEnv, encoding: 'utf8' }
);
assert.notStrictEqual(r.status, 0, 'feedback list --token must be rejected');
assert.ok(/Unknown option|token/.test(r.stderr), 'stderr mentions unknown flag: ' + r.stderr);
console.log('✓ CLI: feedback list rejects --service-url / --token via strict parser');

/* ── CLI: internal namespace works (scan-correction) ── */
r = spawnSync(process.execPath, [CLI, 'internal', 'scan-correction', 'no, that is wrong'], { env: flagEnv, encoding: 'utf8' });
assert.strictEqual(r.status, 0, 'internal scan-correction hits on correction-language');
assert.ok(/hit/.test(r.stdout), 'internal scan-correction prints hit');
r = spawnSync(process.execPath, [CLI, 'internal', 'scan-correction', 'also add pagination'], { env: flagEnv, encoding: 'utf8' });
assert.strictEqual(r.status, 1, 'internal scan-correction misses on neutral text');
assert.ok(/miss/.test(r.stdout), 'internal scan-correction prints miss');
console.log('✓ CLI: `loopback internal scan-correction` works as expected');

console.log('\nSETUP SMOKE OK (homes: ' + tmpHome + ', ' + noAuthHome + ', ' + authHome + ', ' + noAuthCliHome + ', ' + happyHome + ', ' + flagHome + ')');
