'use strict';
/*
 * Internal installer module — exposed to users as `loopback setup <harness>`.
 *
 * For each named harness it writes everything automatically, with NO
 * marketplace and NO manual config edits: registers the MCP server (absolute
 * path to the prebuilt bundle), wires hooks where supported, and copies the
 * canonical skill + slash command into the harness's own directories. All
 * steps are idempotent (read → merge → write, preserving the user's other
 * settings).
 *
 * Credentials are NOT injected per-harness env block — they live in
 * ~/.loopback/config.json and the MCP server reads them at submit time.
 * `installHarness` exits 1 if no credentials are configured; the caller (the
 * CLI dispatcher) surfaces that as "run `loopback auth …` first".
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

// Read the entire [mcp_servers.loopback.env] block as-is from a Codex TOML
// string. Used by installCodex to preserve any env keys the user added under
// the loopback entry across re-runs. Stdlib-only; handles the simple
// `KEY = "value"` form (which is what we write).
function readCodexEnvBlock(content) {
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

function installClaudeCode(options) {
  const actions = [];

  // 1. MCP server — register at user scope via the claude CLI (safe, supported).
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
    warn('claude CLI not found — skipped MCP registration; install Claude Code, then re-run `loopback setup claude-code`.');
  }

  // 2. Hooks — opt-in via --automatic-feedback-detection. Skipping leaves any
  // pre-existing hook entries (loopback or otherwise) untouched.
  if (options && options.automaticFeedbackDetection) {
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
  } else {
    actions.push('skipped hook installation (pass --automatic-feedback-detection to enable)');
  }

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

function installOpenCode() {
  const dir = openCodeConfigDir();
  const actions = [];

  // 1. MCP — inject mcp.loopback into opencode.json (prefer existing .jsonc).
  // Credentials live in ~/.loopback/config.json, not in the harness env block.
  // If the user has added their own env entries to the loopback entry, those
  // are preserved verbatim across re-runs (we don't touch them).
  const jsonc = path.join(dir, 'opencode.jsonc');
  const configPath = exists(jsonc) ? jsonc : path.join(dir, 'opencode.json');
  const config = readJSON(configPath);
  config.mcp = config.mcp || {};
  const prior = config.mcp.loopback || {};
  const entry = { type: 'local', command: ['node', MCP_BUNDLE], enabled: true };
  if (prior.environment && typeof prior.environment === 'object' && Object.keys(prior.environment).length) {
    entry.environment = prior.environment;
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

function installCodex() {
  const configPath = codexConfigPath();
  const actions = [];

  // Preserve any pre-existing env keys the user added under the loopback entry
  // (e.g. a manual per-harness override). We never inject LOOPBACK_* ourselves;
  // whatever the user put there is theirs to manage.
  const existing = exists(configPath) ? fs.readFileSync(configPath, 'utf8') : '';
  const preservedEnv = readCodexEnvBlock(existing);

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

const INSTALLERS = {
  'claude-code': installClaudeCode,
  opencode: installOpenCode,
  codex: installCodex,
};

// Throws if ~/.loopback/config.json lacks a service URL or token. The CLI
// dispatcher catches this and prints an actionable message + exits 1.
function requireAuth() {
  const { serviceUrl, token } = core.config.resolveCredentials({});
  if (!serviceUrl || !token) {
    const e = new Error('no credentials configured — run `loopback auth --service-url URL --token TOK` first');
    e.code = 'NO_AUTH';
    throw e;
  }
  return { serviceUrl, token };
}

// Install loopback into one named harness. Validates that auth is configured
// before doing anything (so installing a non-functional MCP entry is never the
// result of a bare invocation). Returns the installer's result object.
function installHarness(harnessName, options) {
  if (!HARNESSES.includes(harnessName)) {
    throw new Error(`unknown harness "${harnessName}" (valid: ${HARNESSES.join(', ')})`);
  }
  if (!exists(MCP_BUNDLE)) {
    throw new Error('MCP bundle not found at ' + MCP_BUNDLE + ' — run `npm run build` first.');
  }
  requireAuth();
  const installer = INSTALLERS[harnessName];
  const r = installer(options || {});
  log(`\n✓ ${r.harness}  (${r.dir})`);
  for (const a of r.actions) log('  - ' + a);
  log('\nDone. The harness is auto-detected at submit time; nothing else to configure.');
  return r;
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

function removeFromHarness(h) {
  if (h === 'claude-code') {
    if (commandExists('claude')) {
      try {
        execFileSync('claude', ['mcp', 'remove', 'loopback', '-s', 'user'], { stdio: 'ignore' });
      } catch (_) {}
    }
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

// Uninstall loopback from one named harness, or from every detected harness
// when `all` is set.
function uninstallHarness(opts) {
  opts = opts || {};
  let targets;
  if (opts.all) {
    targets = detectHarnesses();
    if (!targets.length) {
      warn('no supported harness detected; nothing to uninstall.');
      return;
    }
  } else {
    targets = (opts.targets || []).filter((h) => HARNESSES.includes(h));
    if (!targets.length) {
      throw new Error(`unknown harness (valid: ${HARNESSES.join(', ')})`);
    }
  }
  for (const h of targets) removeFromHarness(h);
}

module.exports = {
  installHarness,
  uninstallHarness,
  detectHarnesses,
  requireAuth,
  HARNESSES,
  // exported for tests:
  installClaudeCode,
  installOpenCode,
  installCodex,
  upsertCodexBlock,
  stripJSONC,
  readCodexEnvBlock,
};
