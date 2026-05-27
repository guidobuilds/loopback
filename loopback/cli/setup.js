'use strict';
/*
 * loopback setup — the one-command installer (engram-style).
 *
 * For each detected/requested harness it writes everything automatically, with
 * NO marketplace and NO manual config edits: registers the MCP server (absolute
 * path to the prebuilt bundle), wires hooks where supported, and copies the
 * canonical skill + slash command into the harness's own directories. All steps
 * are idempotent (read → merge → write, preserving the user's other settings).
 *
 * Harness identity is NOT configured here — the MCP server auto-detects it at
 * runtime (see core/data-dir.js resolveHarness).
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const core = require('../core');

const PKG_ROOT = path.resolve(__dirname, '..'); // loopback/
const MCP_BUNDLE = path.join(PKG_ROOT, 'mcp', 'server.bundle.js');
const CLI_PATH = path.join(PKG_ROOT, 'cli', 'index.js');
const SKILL_SRC = path.join(PKG_ROOT, 'skills', 'feedback-detector');
const COMMAND_SRC = path.join(PKG_ROOT, 'commands', 'harness-feedback.md');
const HOOKS_DIR = path.join(PKG_ROOT, 'hooks');
const OPENCODE_PLUGIN_SRC = path.join(PKG_ROOT, 'adapters', 'opencode', 'plugins', 'loopback.ts');

const HARNESSES = ['claude-code', 'opencode', 'codex'];
const LOOPBACK_ENV_KEYS = ['LOOPBACK_INGEST_URL', 'LOOPBACK_TOKEN'];

function home() {
  return process.env.HOME || os.homedir();
}

function log(...a) {
  process.stdout.write(a.join(' ') + '\n');
}
function warn(...a) {
  process.stderr.write('warning: ' + a.join(' ') + '\n');
}

function commandExists(cmd) {
  try {
    execFileSync(process.platform === 'win32' ? 'where' : 'which', [cmd], { stdio: 'ignore' });
    return true;
  } catch (_) {
    return false;
  }
}

function exists(p) {
  try {
    fs.accessSync(p);
    return true;
  } catch (_) {
    return false;
  }
}

function copyDir(src, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.cpSync(src, dest, { recursive: true });
}
function copyFile(src, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
}

function readJSON(p) {
  try {
    return JSON.parse(stripJSONC(fs.readFileSync(p, 'utf8')));
  } catch (_) {
    return {};
  }
}
function writeJSON(p, obj) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(obj, null, 2) + '\n');
}

// Strip // and /* */ comments (JSONC) so we can parse opencode.jsonc. Comments
// inside strings are preserved. (Rewrites lose comments — acceptable, matches
// engram's behavior.)
function stripJSONC(data) {
  let out = '';
  let i = 0;
  const s = String(data);
  while (i < s.length) {
    if (s[i] === '"') {
      out += s[i++];
      while (i < s.length && s[i] !== '"') {
        if (s[i] === '\\' && i + 1 < s.length) {
          out += s[i] + s[i + 1];
          i += 2;
          continue;
        }
        out += s[i++];
      }
      if (i < s.length) out += s[i++];
      continue;
    }
    if (s[i] === '/' && s[i + 1] === '/') {
      while (i < s.length && s[i] !== '\n') i++;
      continue;
    }
    if (s[i] === '/' && s[i + 1] === '*') {
      i += 2;
      while (i + 1 < s.length && !(s[i] === '*' && s[i + 1] === '/')) i++;
      i = i + 1 < s.length ? i + 2 : s.length;
      continue;
    }
    out += s[i++];
  }
  return out;
}

// Split a harness env-block-shaped object into:
//   - loopback: any LOOPBACK_* keys (will be migrated to ~/.loopback/config.json)
//   - rest:     everything else (PRESERVED in the harness config)
// Returns `null` for `rest` when there are no non-loopback keys, so callers can
// drop empty env blocks entirely.
function splitEnvBlock(block) {
  const out = { loopback: {}, rest: {} };
  if (!block || typeof block !== 'object') return out;
  for (const [k, v] of Object.entries(block)) {
    if (LOOPBACK_ENV_KEYS.includes(k)) out.loopback[k] = v;
    else out.rest[k] = v;
  }
  return out;
}

// Pull LOOPBACK_* env values harvested from a harness config into
// ~/.loopback/config.json — but ONLY when the on-disk config is missing or has
// an empty field. Never clobbers a user's existing canonical config.
function migrateLoopbackEnv(loopbackEnv) {
  if (!loopbackEnv || Object.keys(loopbackEnv).length === 0) return false;
  const file = core.config.loadConfig();
  const patch = {};
  if (!file.ingestUrl && loopbackEnv.LOOPBACK_INGEST_URL) {
    patch.ingestUrl = loopbackEnv.LOOPBACK_INGEST_URL;
  }
  if (!file.token && loopbackEnv.LOOPBACK_TOKEN) {
    patch.token = loopbackEnv.LOOPBACK_TOKEN;
  }
  if (Object.keys(patch).length === 0) return false;
  core.config.saveConfig(patch);
  return true;
}

// Pre-pass: detect legacy `env`/`environment` blocks containing LOOPBACK_*
// entries across every harness config we know about, harvest those values into
// ~/.loopback/config.json (if it's missing or empty), then strip the LOOPBACK_*
// keys from the harness blocks so subsequent reads/writes don't reintroduce
// them. Preserves any unrelated env keys the user had set.
//
// Why a pre-pass: for Claude Code we call `claude mcp remove` before
// `claude mcp add-json`, which wipes the prior env block from ~/.claude.json.
// We must read+migrate BEFORE that removal, regardless of which harnesses the
// caller asked to install.
function migrateLegacyEnvBlocks() {
  let migrated = 0;

  // Claude Code: read ~/.claude.json directly (the claude CLI's stored
  // user-scope MCP config) and strip the env block before `claude mcp remove`
  // gets a chance to wipe it.
  const ccJsonPath = path.join(home(), '.claude.json');
  if (exists(ccJsonPath)) {
    try {
      const ccJson = JSON.parse(fs.readFileSync(ccJsonPath, 'utf8'));
      const mcp = ccJson && ccJson.mcpServers && ccJson.mcpServers.loopback;
      if (mcp && mcp.env && typeof mcp.env === 'object') {
        const split = splitEnvBlock(mcp.env);
        if (Object.keys(split.loopback).length) {
          if (migrateLoopbackEnv(split.loopback)) migrated++;
          if (Object.keys(split.rest).length) mcp.env = split.rest;
          else delete mcp.env;
          fs.writeFileSync(ccJsonPath, JSON.stringify(ccJson, null, 2) + '\n');
        }
      }
    } catch (_) {
      /* unreadable / unparseable -> skip; setup will continue */
    }
  }

  // OpenCode: opencode.json or opencode.jsonc.
  const ocDir = openCodeConfigDir();
  const ocPath = exists(path.join(ocDir, 'opencode.jsonc'))
    ? path.join(ocDir, 'opencode.jsonc')
    : path.join(ocDir, 'opencode.json');
  if (exists(ocPath)) {
    const cfg = readJSON(ocPath);
    const entry = cfg && cfg.mcp && cfg.mcp.loopback;
    if (entry && entry.environment && typeof entry.environment === 'object') {
      const split = splitEnvBlock(entry.environment);
      if (Object.keys(split.loopback).length) {
        if (migrateLoopbackEnv(split.loopback)) migrated++;
        if (Object.keys(split.rest).length) entry.environment = split.rest;
        else delete entry.environment;
        writeJSON(ocPath, cfg);
      }
    }
  }

  // Codex: TOML — best-effort parse of [mcp_servers.loopback.env] block. We
  // don't pull in a TOML parser; instead we scan the file and either rewrite
  // or drop the env section.
  const codexPath = codexConfigPath();
  if (exists(codexPath)) {
    const before = fs.readFileSync(codexPath, 'utf8');
    const { content: after, migrated: lp } = migrateCodexEnv(before);
    if (lp && Object.keys(lp).length) {
      if (migrateLoopbackEnv(lp)) migrated++;
      if (after !== before) fs.writeFileSync(codexPath, after);
    }
  }

  return migrated;
}

// Parse [mcp_servers.loopback.env] from a TOML string and return:
//   { content: <rewritten TOML with LOOPBACK_* keys stripped (or section dropped)>,
//     migrated: { LOOPBACK_INGEST_URL?: string, LOOPBACK_TOKEN?: string } | null }
// Stdlib-only; only handles the simple `KEY = "value"` form (which is what
// installCodex emits). Anything fancier is left untouched and not migrated.
function migrateCodexEnv(content) {
  const lines = String(content).replace(/\r\n/g, '\n').split('\n');
  const out = [];
  const migrated = {};
  let inEnv = false;
  let envStart = -1;
  let envLines = []; // lines kept (non-loopback env entries)
  let touched = false;

  function flushEnv() {
    if (envStart < 0) return;
    // Decide whether to keep the [mcp_servers.loopback.env] section.
    const keep = envLines.some((l) => /^\s*[A-Za-z_][A-Za-z0-9_]*\s*=/.test(l));
    if (keep) {
      out.push('[mcp_servers.loopback.env]');
      for (const l of envLines) out.push(l);
    }
    envStart = -1;
    envLines = [];
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    if (trimmed === '[mcp_servers.loopback.env]') {
      inEnv = true;
      envStart = out.length;
      envLines = [];
      continue;
    }
    if (inEnv && trimmed.startsWith('[') && trimmed.endsWith(']')) {
      inEnv = false;
      flushEnv();
      out.push(line);
      continue;
    }
    if (inEnv) {
      const m = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*"((?:\\.|[^"\\])*)"\s*$/);
      if (m && LOOPBACK_ENV_KEYS.includes(m[1])) {
        // Capture the value (handle the same \\-escapes that JSON.stringify emits).
        try {
          migrated[m[1]] = JSON.parse('"' + m[2] + '"');
        } catch (_) {
          migrated[m[1]] = m[2];
        }
        touched = true;
        continue; // drop this line
      }
      envLines.push(line);
      continue;
    }
    out.push(line);
  }
  if (inEnv) flushEnv();

  if (!touched) {
    return { content, migrated: null };
  }
  // Collapse any run of >2 blank lines to keep output tidy.
  let joined = out.join('\n').replace(/\n{3,}/g, '\n\n');
  if (!joined.endsWith('\n')) joined += '\n';
  return { content: joined, migrated };
}

// Read non-loopback env entries from an existing [mcp_servers.loopback.env]
// section, so installCodex can preserve them across re-runs. Returns an object
// of survivor keys (already excludes LOOPBACK_*); empty if nothing to keep.
function readCodexLoopbackEnv(content) {
  const lines = String(content).replace(/\r\n/g, '\n').split('\n');
  let inEnv = false;
  const out = {};
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === '[mcp_servers.loopback.env]') { inEnv = true; continue; }
    if (inEnv && trimmed.startsWith('[') && trimmed.endsWith(']')) { inEnv = false; continue; }
    if (!inEnv) continue;
    const m = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*"((?:\\.|[^"\\])*)"\s*$/);
    if (!m) continue;
    if (LOOPBACK_ENV_KEYS.includes(m[1])) continue;
    try { out[m[1]] = JSON.parse('"' + m[2] + '"'); } catch (_) { out[m[1]] = m[2]; }
  }
  return out;
}

/* ───────────────────────── Claude Code (plugin-less) ───────────────────── */

const CC_HOOKS = [
  { event: 'PostToolUse', matcher: 'Write|Edit', script: 'on-post-tooluse.js' },
  { event: 'UserPromptSubmit', script: 'on-user-prompt.js' },
  { event: 'Stop', script: 'on-stop.js' },
  { event: 'SessionStart', script: 'on-session-start.js' },
];

function claudeDir() {
  return path.join(home(), '.claude');
}

function installClaudeCode(secrets) {
  const actions = [];

  // 1. MCP server — register at user scope via the claude CLI (safe, supported).
  // Credentials are NOT injected here; the MCP server reads them from
  // ~/.loopback/config.json (or the inherited LOOPBACK_* env vars). The legacy
  // env-block migration (if any) ran earlier in setup() via
  // migrateLegacyEnvBlocks(), which reads ~/.claude.json directly BEFORE the
  // `claude mcp remove` below wipes it.
  if (commandExists('claude')) {
    const spec = { command: 'node', args: [MCP_BUNDLE] };
    try {
      execFileSync('claude', ['mcp', 'remove', 'loopback', '-s', 'user'], { stdio: 'ignore' });
    } catch (_) {
      /* not present yet — fine */
    }
    execFileSync('claude', ['mcp', 'add-json', 'loopback', JSON.stringify(spec), '-s', 'user'], { stdio: 'ignore' });
    actions.push('registered MCP server (user scope)');
  } else {
    warn('claude CLI not found — skipped MCP registration; install Claude Code, then re-run `loopback setup`.');
  }

  // 2. Hooks — merge into ~/.claude/settings.json (idempotent by command string).
  const settingsPath = path.join(claudeDir(), 'settings.json');
  const settings = readJSON(settingsPath);
  settings.hooks = settings.hooks || {};
  let added = 0;
  for (const h of CC_HOOKS) {
    const command = `node "${path.join(HOOKS_DIR, h.script)}"`;
    const list = (settings.hooks[h.event] = settings.hooks[h.event] || []);
    const present = list.some((e) => (e.hooks || []).some((x) => x.command === command));
    if (!present) {
      const entry = { hooks: [{ type: 'command', command }] };
      if (h.matcher) entry.matcher = h.matcher;
      list.push(entry);
      added++;
    }
  }
  if (added) writeJSON(settingsPath, settings);
  actions.push(`wired ${added} hook(s) into settings.json`);

  // 3. Skill + 4. command.
  copyDir(SKILL_SRC, path.join(claudeDir(), 'skills', 'feedback-detector'));
  copyFile(COMMAND_SRC, path.join(claudeDir(), 'commands', 'harness-feedback.md'));
  actions.push('copied skill + /harness-feedback command');

  return { harness: 'claude-code', dir: claudeDir(), actions };
}

/* ───────────────────────────── OpenCode ────────────────────────────────── */

function openCodeConfigDir() {
  const xdg = process.env.XDG_CONFIG_HOME;
  return xdg ? path.join(xdg, 'opencode') : path.join(home(), '.config', 'opencode');
}

function installOpenCode(secrets) {
  const dir = openCodeConfigDir();
  const actions = [];

  // 1. MCP — inject mcp.loopback into opencode.json (prefer existing .jsonc).
  // No LOOPBACK_* values are written into the `environment` block — those live
  // in ~/.loopback/config.json. However, if the user added unrelated env vars
  // to their existing entry, we preserve them.
  const jsonc = path.join(dir, 'opencode.jsonc');
  const configPath = exists(jsonc) ? jsonc : path.join(dir, 'opencode.json');
  const config = readJSON(configPath);
  config.mcp = config.mcp || {};
  const prior = config.mcp.loopback || {};
  const entry = { type: 'local', command: ['node', MCP_BUNDLE], enabled: true };
  if (prior.environment && typeof prior.environment === 'object') {
    const { rest } = splitEnvBlock(prior.environment);
    if (Object.keys(rest).length) entry.environment = rest;
  }
  config.mcp.loopback = entry;
  writeJSON(configPath, config);
  actions.push('registered MCP server in ' + path.basename(configPath));

  // 2. Plugin — copy loopback.ts, baking the absolute CLI path as fallback.
  const pluginSrc = fs.readFileSync(OPENCODE_PLUGIN_SRC, 'utf8');
  const patched = pluginSrc.replace('process.env.LOOPBACK_CLI || ""', `process.env.LOOPBACK_CLI || ${JSON.stringify(CLI_PATH)}`);
  const pluginDest = path.join(dir, 'plugins', 'loopback.ts');
  fs.mkdirSync(path.dirname(pluginDest), { recursive: true });
  fs.writeFileSync(pluginDest, patched);
  actions.push('installed tripwire plugin (baked CLI path)');

  // 3. Skill + 4. command.
  copyDir(SKILL_SRC, path.join(dir, 'skills', 'feedback-detector'));
  copyFile(COMMAND_SRC, path.join(dir, 'commands', 'harness-feedback.md'));
  actions.push('copied skill + /harness-feedback command');

  return { harness: 'opencode', dir, actions };
}

/* ─────────────────────────────── Codex ─────────────────────────────────── */

function codexConfigPath() {
  return path.join(home(), '.codex', 'config.toml');
}

// Remove any existing [mcp_servers.loopback...] blocks, then append a fresh one.
function upsertCodexBlock(content, block) {
  const lines = String(content).replace(/\r\n/g, '\n').split('\n');
  const kept = [];
  for (let i = 0; i < lines.length; ) {
    const t = lines[i].trim();
    if (t === '[mcp_servers.loopback]' || t.startsWith('[mcp_servers.loopback.')) {
      i++;
      while (i < lines.length) {
        const n = lines[i].trim();
        if (n.startsWith('[') && n.endsWith(']') && !n.startsWith('[mcp_servers.loopback.')) break;
        if (n === '[mcp_servers.loopback]') break;
        i++;
      }
      continue;
    }
    kept.push(lines[i]);
    i++;
  }
  const base = kept.join('\n').trim();
  return (base ? base + '\n\n' : '') + block.trim() + '\n';
}

function installCodex(secrets) {
  const configPath = codexConfigPath();
  const actions = [];

  // Preserve any pre-existing non-loopback env keys the user had set on the
  // loopback entry (e.g. a manual per-harness override of a non-credential
  // var). LOOPBACK_* keys were stripped earlier by migrateLegacyEnvBlocks(),
  // so by this point env-block scanning here just preserves the survivors.
  const existing = exists(configPath) ? fs.readFileSync(configPath, 'utf8') : '';
  const preservedEnv = readCodexLoopbackEnv(existing); // already stripped of LOOPBACK_*

  let block = '[mcp_servers.loopback]\ncommand = "node"\nargs = [' + JSON.stringify(MCP_BUNDLE) + ']\n';
  if (preservedEnv && Object.keys(preservedEnv).length) {
    block += '\n[mcp_servers.loopback.env]\n';
    for (const [k, v] of Object.entries(preservedEnv)) block += `${k} = ${JSON.stringify(v)}\n`;
  }
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, upsertCodexBlock(existing, block));
  actions.push('registered MCP server in config.toml');

  // Skill (agent-compatible path) + prompt (slash command).
  copyDir(SKILL_SRC, path.join(home(), '.agents', 'skills', 'feedback-detector'));
  copyFile(COMMAND_SRC, path.join(home(), '.codex', 'prompts', 'harness-feedback.md'));
  actions.push('copied skill + /harness-feedback prompt');

  return { harness: 'codex', dir: path.dirname(configPath), actions };
}

/* ──────────────────────────── orchestration ────────────────────────────── */

function detectHarnesses() {
  const found = [];
  if (commandExists('claude') || exists(claudeDir())) found.push('claude-code');
  if (commandExists('opencode') || exists(openCodeConfigDir())) found.push('opencode');
  if (commandExists('codex') || exists(path.join(home(), '.codex'))) found.push('codex');
  return found;
}

function resolveSecrets(opts) {
  // Precedence (flag > env > ~/.loopback/config.json) lives in
  // core.config.resolveCredentials. We keep the `|| ''` boundary so the rest of
  // setup.js can stay on string-truthy checks instead of `=== undefined`.
  const { ingestUrl, token } = core.config.resolveCredentials({
    flagToken: opts.token,
    flagUrl: opts.ingestUrl,
  });
  return { ingestUrl: ingestUrl || '', token: token || '' };
}

const INSTALLERS = {
  'claude-code': installClaudeCode,
  opencode: installOpenCode,
  codex: installCodex,
};

function setup(opts) {
  opts = opts || {};
  if (!exists(MCP_BUNDLE)) {
    throw new Error('MCP bundle not found at ' + MCP_BUNDLE + ' — run `npm run build` first.');
  }
  let targets = (opts.harnesses && opts.harnesses.length ? opts.harnesses : detectHarnesses()).filter((h) =>
    HARNESSES.includes(h)
  );
  if (!targets.length) {
    warn('no supported harness detected (claude-code/opencode/codex). Pass one explicitly: `loopback setup claude-code`.');
    return [];
  }

  // Pre-pass: migrate any legacy `env`/`environment` LOOPBACK_* blocks from
  // each harness's config into ~/.loopback/config.json, then strip them. Runs
  // BEFORE installers so that Claude Code's `claude mcp remove` (inside
  // installClaudeCode) can't wipe them before we read them.
  const migrated = migrateLegacyEnvBlocks();
  if (migrated) {
    log(`migrated legacy LOOPBACK_* env block(s) from ${migrated} harness config(s) into ${core.config.configPath()}`);
  }

  const secrets = resolveSecrets(opts);
  // Persist whatever the user passed on this invocation (or inherited from env)
  // to the single source of truth — but only when at least one explicit value
  // is supplied via flag or env, so a bare `loopback setup` re-run is a no-op.
  if ((opts.ingestUrl || opts.token || process.env.LOOPBACK_INGEST_URL || process.env.LOOPBACK_TOKEN) &&
      (secrets.ingestUrl || secrets.token)) {
    core.config.saveConfig({ ingestUrl: secrets.ingestUrl, token: secrets.token });
    log(`wrote credentials to ${core.config.configPath()} (mode 0600)`);
  }
  if (!secrets.ingestUrl || !secrets.token) {
    warn('LOOPBACK_INGEST_URL / LOOPBACK_TOKEN not provided (flag, env, or ~/.loopback/config.json). Installing anyway; run `loopback config --ingest-url URL --token TOK` before submitting feedback.');
  }

  const results = [];
  for (const h of targets) {
    try {
      const r = INSTALLERS[h](secrets);
      results.push(r);
      log(`\n✓ ${r.harness}  (${r.dir})`);
      for (const a of r.actions) log('  - ' + a);
    } catch (e) {
      warn(`${h}: ${e.message}`);
    }
  }
  log('\nDone. The harness is auto-detected at submit time; nothing else to configure.');
  return results;
}

/* ─────────────────────────────── uninstall ─────────────────────────────── */

function rm(p) {
  try {
    fs.rmSync(p, { recursive: true, force: true });
    return true;
  } catch (_) {
    return false;
  }
}

function uninstall(opts) {
  opts = opts || {};
  const targets = (opts.harnesses && opts.harnesses.length ? opts.harnesses : detectHarnesses()).filter((h) =>
    HARNESSES.includes(h)
  );
  for (const h of targets) {
    if (h === 'claude-code') {
      if (commandExists('claude')) {
        try {
          execFileSync('claude', ['mcp', 'remove', 'loopback', '-s', 'user'], { stdio: 'ignore' });
        } catch (_) {}
      }
      // Remove our hook entries from settings.json.
      const sp = path.join(claudeDir(), 'settings.json');
      if (exists(sp)) {
        const s = readJSON(sp);
        if (s.hooks) {
          for (const h2 of CC_HOOKS) {
            const cmd = `node "${path.join(HOOKS_DIR, h2.script)}"`;
            if (s.hooks[h2.event]) {
              s.hooks[h2.event] = s.hooks[h2.event].filter((e) => !(e.hooks || []).some((x) => x.command === cmd));
              if (!s.hooks[h2.event].length) delete s.hooks[h2.event];
            }
          }
          writeJSON(sp, s);
        }
      }
      rm(path.join(claudeDir(), 'skills', 'feedback-detector'));
      rm(path.join(claudeDir(), 'commands', 'harness-feedback.md'));
    } else if (h === 'opencode') {
      const dir = openCodeConfigDir();
      const cp = exists(path.join(dir, 'opencode.jsonc')) ? path.join(dir, 'opencode.jsonc') : path.join(dir, 'opencode.json');
      if (exists(cp)) {
        const c = readJSON(cp);
        if (c.mcp && c.mcp.loopback) {
          delete c.mcp.loopback;
          writeJSON(cp, c);
        }
      }
      rm(path.join(dir, 'plugins', 'loopback.ts'));
      rm(path.join(dir, 'skills', 'feedback-detector'));
      rm(path.join(dir, 'commands', 'harness-feedback.md'));
    } else if (h === 'codex') {
      const cp = codexConfigPath();
      if (exists(cp)) fs.writeFileSync(cp, upsertCodexBlock(fs.readFileSync(cp, 'utf8'), '').trim() + '\n');
      rm(path.join(home(), '.agents', 'skills', 'feedback-detector'));
      rm(path.join(home(), '.codex', 'prompts', 'harness-feedback.md'));
    }
    log(`✓ removed loopback from ${h}`);
  }
}

module.exports = {
  setup,
  uninstall,
  detectHarnesses,
  // exported for tests:
  installClaudeCode,
  installOpenCode,
  installCodex,
  upsertCodexBlock,
  stripJSONC,
  migrateLegacyEnvBlocks,
  migrateCodexEnv,
  splitEnvBlock,
};
