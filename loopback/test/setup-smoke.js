'use strict';
/* Installer smoke: run `loopback setup` against a throwaway HOME and assert each
 * harness gets correct, idempotent config + assets. Never touches the real HOME. */

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'lb-home-'));
process.env.HOME = tmpHome;
delete process.env.XDG_CONFIG_HOME;

const setup = require('../cli/setup');

const BUNDLE = path.resolve(__dirname, '..', 'mcp', 'server.bundle.js');
const CLI = path.resolve(__dirname, '..', 'cli', 'index.js');
const secrets = { ingestUrl: 'http://svc.local/feedback', token: 'lpbk_test' };

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

/* ── OpenCode ── */
setup.installOpenCode(secrets);
const ocPath = path.join(tmpHome, '.config', 'opencode', 'opencode.json');
const oc = JSON.parse(read(ocPath));
assert.deepStrictEqual(oc.mcp.loopback.command, ['node', BUNDLE], 'opencode MCP command');
assert.strictEqual(oc.mcp.loopback.type, 'local');
assert.strictEqual(oc.mcp.loopback.environment.LOOPBACK_INGEST_URL, secrets.ingestUrl);
const ocPlugin = read(path.join(tmpHome, '.config', 'opencode', 'plugins', 'loopback.ts'));
assert.ok(ocPlugin.includes(`process.env.LOOPBACK_CLI || ${JSON.stringify(CLI)}`), 'opencode plugin baked CLI path');
assert.ok(exists(path.join(tmpHome, '.config', 'opencode', 'skills', 'feedback-detector', 'SKILL.md')), 'opencode skill');
assert.ok(exists(path.join(tmpHome, '.config', 'opencode', 'commands', 'harness-feedback.md')), 'opencode command');
console.log('✓ opencode: MCP + plugin(baked) + skill + command');

// preserves unrelated config + idempotent
fs.writeFileSync(ocPath, JSON.stringify({ theme: 'dark', mcp: { other: { type: 'local', command: ['x'] } } }, null, 2));
setup.installOpenCode(secrets);
const oc2 = JSON.parse(read(ocPath));
assert.strictEqual(oc2.theme, 'dark', 'preserved unrelated key');
assert.ok(oc2.mcp.other, 'preserved other MCP server');
assert.ok(oc2.mcp.loopback, 'added loopback alongside');
console.log('✓ opencode: idempotent + preserves existing config');

/* ── Codex ── */
setup.installCodex(secrets);
const codexCfg = path.join(tmpHome, '.codex', 'config.toml');
let toml = read(codexCfg);
assert.ok(toml.includes('[mcp_servers.loopback]'), 'codex MCP block');
assert.ok(toml.includes(JSON.stringify(BUNDLE)), 'codex bundle path');
assert.ok(toml.includes('[mcp_servers.loopback.env]') && toml.includes(secrets.ingestUrl), 'codex env');
assert.ok(exists(path.join(tmpHome, '.agents', 'skills', 'feedback-detector', 'SKILL.md')), 'codex skill');
assert.ok(exists(path.join(tmpHome, '.codex', 'prompts', 'harness-feedback.md')), 'codex prompt');
setup.installCodex(secrets); // idempotent
toml = read(codexCfg);
assert.strictEqual(toml.match(/\[mcp_servers\.loopback\]/g).length, 1, 'codex block not duplicated');
console.log('✓ codex: MCP(toml) + skill + prompt + idempotent');

/* ── Claude Code (file parts; force claude CLI "absent" via empty PATH) ── */
const savedPath = process.env.PATH;
process.env.PATH = '';
setup.installClaudeCode(secrets);
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
setup.installClaudeCode(secrets);
process.env.PATH = savedPath;
const s2 = JSON.parse(read(ccSettings));
assert.ok(s2.hooks.PreToolUse, 'preserved unrelated hook');
assert.strictEqual(s2.hooks.Stop.length, 1, 'Stop hook not duplicated on re-run');
console.log('✓ claude-code: hooks merge + skill + command + idempotent + preserves existing hooks');

console.log('\nSETUP SMOKE OK (home: ' + tmpHome + ')');
