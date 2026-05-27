'use strict';
/* Installer smoke: run `loopback setup` against a throwaway HOME and assert each
 * harness gets correct, idempotent config + assets. Never touches the real HOME.
 *
 * Post single-source-of-truth migration, this also asserts:
 *   1. NO `env`/`environment` blocks for LOOPBACK_* are written by setup.
 *   2. ~/.loopback/config.json IS written with the supplied credentials at 0600.
 *   3. Legacy env blocks (LOOPBACK_TOKEN/LOOPBACK_INGEST_URL) in any harness
 *      config are migrated into ~/.loopback/config.json and stripped, while
 *      non-loopback env entries survive. */

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'lb-home-'));
process.env.HOME = tmpHome;
delete process.env.XDG_CONFIG_HOME;
// The new config resolver and the installer also honor LOOPBACK_* env vars.
// Clear them so this suite tests the file-only path deterministically.
delete process.env.LOOPBACK_INGEST_URL;
delete process.env.LOOPBACK_TOKEN;

const setup = require('../cli/setup');
const core = require('../core');

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
// No `environment` block at all (no LOOPBACK_* and no other survivors).
assert.strictEqual(oc.mcp.loopback.environment, undefined, 'opencode: no environment block written');
const ocPlugin = read(path.join(tmpHome, '.config', 'opencode', 'plugins', 'loopback.ts'));
assert.ok(ocPlugin.includes(`process.env.LOOPBACK_CLI || ${JSON.stringify(CLI)}`), 'opencode plugin baked CLI path');
assert.ok(exists(path.join(tmpHome, '.config', 'opencode', 'skills', 'feedback-detector', 'SKILL.md')), 'opencode skill');
assert.ok(exists(path.join(tmpHome, '.config', 'opencode', 'commands', 'harness-feedback.md')), 'opencode command');
console.log('✓ opencode: MCP + plugin(baked) + skill + command (no env block)');

// preserves unrelated config + idempotent
fs.writeFileSync(ocPath, JSON.stringify({ theme: 'dark', mcp: { other: { type: 'local', command: ['x'] } } }, null, 2));
setup.installOpenCode(secrets);
const oc2 = JSON.parse(read(ocPath));
assert.strictEqual(oc2.theme, 'dark', 'preserved unrelated key');
assert.ok(oc2.mcp.other, 'preserved other MCP server');
assert.ok(oc2.mcp.loopback, 'added loopback alongside');
console.log('✓ opencode: idempotent + preserves existing config');

// Preserves non-loopback survivors in the loopback entry's environment block.
fs.writeFileSync(
  ocPath,
  JSON.stringify(
    { mcp: { loopback: { type: 'local', command: ['old'], environment: { MY_PROXY: 'http://p', LOOPBACK_TOKEN: 'leftover' } } } },
    null,
    2
  )
);
setup.installOpenCode(secrets);
const oc3 = JSON.parse(read(ocPath));
assert.deepStrictEqual(oc3.mcp.loopback.environment, { MY_PROXY: 'http://p' }, 'opencode: non-loopback env survivor preserved, LOOPBACK_TOKEN stripped');
console.log('✓ opencode: preserves non-loopback env survivors, strips LOOPBACK_*');

/* ── Codex ── */
setup.installCodex(secrets);
const codexCfg = path.join(tmpHome, '.codex', 'config.toml');
let toml = read(codexCfg);
assert.ok(toml.includes('[mcp_servers.loopback]'), 'codex MCP block');
assert.ok(toml.includes(JSON.stringify(BUNDLE)), 'codex bundle path');
// No LOOPBACK_* env keys in the TOML.
assert.ok(!/LOOPBACK_TOKEN\s*=/.test(toml), 'codex: no LOOPBACK_TOKEN in TOML');
assert.ok(!/LOOPBACK_INGEST_URL\s*=/.test(toml), 'codex: no LOOPBACK_INGEST_URL in TOML');
assert.ok(exists(path.join(tmpHome, '.agents', 'skills', 'feedback-detector', 'SKILL.md')), 'codex skill');
assert.ok(exists(path.join(tmpHome, '.codex', 'prompts', 'harness-feedback.md')), 'codex prompt');
setup.installCodex(secrets); // idempotent
toml = read(codexCfg);
assert.strictEqual(toml.match(/\[mcp_servers\.loopback\]/g).length, 1, 'codex block not duplicated');
console.log('✓ codex: MCP(toml) + skill + prompt + idempotent (no env block)');

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

/* ── setup() end-to-end: writes ~/.loopback/config.json @ 0600, no env blocks ── */
// Fresh HOME for the end-to-end run (independent of the per-installer tests
// above so we can assert on the file written by setup() exactly).
const e2eHome = fs.mkdtempSync(path.join(os.tmpdir(), 'lb-home-e2e-'));
process.env.HOME = e2eHome;
delete process.env.XDG_CONFIG_HOME;
// Force claude CLI "absent" so setup() doesn't try to shell out to it.
const savedPath2 = process.env.PATH;
process.env.PATH = '';
setup.setup({ harnesses: ['claude-code', 'opencode', 'codex'], ingestUrl: secrets.ingestUrl, token: secrets.token });
process.env.PATH = savedPath2;

const cfgPath = path.join(e2eHome, '.loopback', 'config.json');
assert.ok(exists(cfgPath), '~/.loopback/config.json written by setup');
const cfg = JSON.parse(read(cfgPath));
assert.strictEqual(cfg.ingestUrl, secrets.ingestUrl, 'config.json ingestUrl');
assert.strictEqual(cfg.token, secrets.token, 'config.json token');
assert.strictEqual(cfg.schemaVersion, 1, 'config.json schemaVersion');
if (process.platform !== 'win32') {
  const mode = fs.statSync(cfgPath).mode & 0o777;
  assert.strictEqual(mode, 0o600, 'config.json mode is 0600: ' + mode.toString(8));
}
// Cross-check the harness configs again under the e2e HOME — none contain LOOPBACK_*.
const e2eOc = JSON.parse(read(path.join(e2eHome, '.config', 'opencode', 'opencode.json')));
assert.strictEqual(e2eOc.mcp.loopback.environment, undefined, 'e2e opencode: no environment block');
const e2eToml = read(path.join(e2eHome, '.codex', 'config.toml'));
assert.ok(!/LOOPBACK_/.test(e2eToml), 'e2e codex: no LOOPBACK_* in TOML');
console.log('✓ setup(): wrote ~/.loopback/config.json (0600), no env blocks in any harness config');

/* ── Legacy env block migration ── */
// Fresh HOME again — pre-populate legacy env blocks in each harness's config,
// then run setup() and verify migration + cleanup.
const migHome = fs.mkdtempSync(path.join(os.tmpdir(), 'lb-home-mig-'));
process.env.HOME = migHome;
delete process.env.XDG_CONFIG_HOME;

// 1. Legacy ~/.claude.json with LOOPBACK_* env block (+ an unrelated key).
fs.mkdirSync(migHome, { recursive: true });
fs.writeFileSync(
  path.join(migHome, '.claude.json'),
  JSON.stringify(
    {
      mcpServers: {
        loopback: {
          command: 'node',
          args: ['/old/bundle.js'],
          env: { LOOPBACK_INGEST_URL: 'http://legacy/feedback', LOOPBACK_TOKEN: 'legacy-tok', MY_DEBUG: '1' },
        },
      },
    },
    null,
    2
  )
);

// 2. Legacy opencode.json with environment block.
fs.mkdirSync(path.join(migHome, '.config', 'opencode'), { recursive: true });
fs.writeFileSync(
  path.join(migHome, '.config', 'opencode', 'opencode.json'),
  JSON.stringify(
    {
      mcp: {
        loopback: {
          type: 'local',
          command: ['node', '/old/bundle.js'],
          environment: { LOOPBACK_INGEST_URL: 'http://legacy-oc/feedback', LOOPBACK_TOKEN: 'legacy-oc-tok', OPENCODE_DBG: 'x' },
        },
      },
    },
    null,
    2
  )
);

// 3. Legacy ~/.codex/config.toml with env section.
fs.mkdirSync(path.join(migHome, '.codex'), { recursive: true });
fs.writeFileSync(
  path.join(migHome, '.codex', 'config.toml'),
  '[mcp_servers.loopback]\ncommand = "node"\nargs = ["/old/bundle.js"]\n\n[mcp_servers.loopback.env]\nLOOPBACK_INGEST_URL = "http://legacy-cx/feedback"\nLOOPBACK_TOKEN = "legacy-cx-tok"\nCODEX_KEEP = "yes"\n'
);

// Run setup WITHOUT flags so migration is the only source of credentials.
const savedPath3 = process.env.PATH;
process.env.PATH = ''; // force "claude CLI absent" so add-json isn't invoked
setup.setup({ harnesses: ['claude-code', 'opencode', 'codex'] });
process.env.PATH = savedPath3;

// ~/.loopback/config.json should now hold the migrated values. Migration
// reads from whichever harness it encounters first — order in
// migrateLegacyEnvBlocks is claude-code, opencode, codex; subsequent
// migrations don't overwrite existing fields.
const migCfg = JSON.parse(read(path.join(migHome, '.loopback', 'config.json')));
assert.strictEqual(migCfg.ingestUrl, 'http://legacy/feedback', 'migrated ingestUrl (from .claude.json)');
assert.strictEqual(migCfg.token, 'legacy-tok', 'migrated token (from .claude.json)');

// Claude .claude.json: LOOPBACK_* gone, MY_DEBUG survives.
const ccAfter = JSON.parse(read(path.join(migHome, '.claude.json')));
const ccEnv = ccAfter.mcpServers && ccAfter.mcpServers.loopback && ccAfter.mcpServers.loopback.env;
assert.deepStrictEqual(ccEnv, { MY_DEBUG: '1' }, '.claude.json env: LOOPBACK_* stripped, MY_DEBUG preserved');

// OpenCode: LOOPBACK_* gone from environment, OPENCODE_DBG survives.
const ocAfter = JSON.parse(read(path.join(migHome, '.config', 'opencode', 'opencode.json')));
assert.deepStrictEqual(
  ocAfter.mcp.loopback.environment,
  { OPENCODE_DBG: 'x' },
  'opencode environment: LOOPBACK_* stripped, OPENCODE_DBG preserved'
);

// Codex: LOOPBACK_* gone from TOML env section, CODEX_KEEP survives.
const cxAfter = read(path.join(migHome, '.codex', 'config.toml'));
assert.ok(!/LOOPBACK_TOKEN\s*=/.test(cxAfter), 'codex TOML: LOOPBACK_TOKEN gone');
assert.ok(!/LOOPBACK_INGEST_URL\s*=/.test(cxAfter), 'codex TOML: LOOPBACK_INGEST_URL gone');
assert.ok(/CODEX_KEEP\s*=\s*"yes"/.test(cxAfter), 'codex TOML: CODEX_KEEP preserved');

console.log('✓ migration: legacy LOOPBACK_* env blocks harvested into ~/.loopback/config.json; unrelated env keys preserved');

console.log('\nSETUP SMOKE OK (homes: ' + tmpHome + ', ' + e2eHome + ', ' + migHome + ')');
