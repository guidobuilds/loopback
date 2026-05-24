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

// Build the MCP env block from resolved secrets (omit empties so the server can
// fall back to inherited process env).
function mcpEnv(secrets) {
  const env = {};
  if (secrets.ingestUrl) env.LOOPBACK_INGEST_URL = secrets.ingestUrl;
  if (secrets.token) env.LOOPBACK_TOKEN = secrets.token;
  return env;
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
  if (commandExists('claude')) {
    const spec = { command: 'node', args: [MCP_BUNDLE] };
    const env = mcpEnv(secrets);
    if (Object.keys(env).length) spec.env = env;
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
  const jsonc = path.join(dir, 'opencode.jsonc');
  const configPath = exists(jsonc) ? jsonc : path.join(dir, 'opencode.json');
  const config = readJSON(configPath);
  config.mcp = config.mcp || {};
  const entry = { type: 'local', command: ['node', MCP_BUNDLE], enabled: true };
  const env = mcpEnv(secrets);
  if (Object.keys(env).length) entry.environment = env;
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

  let block = '[mcp_servers.loopback]\ncommand = "node"\nargs = [' + JSON.stringify(MCP_BUNDLE) + ']\n';
  const env = mcpEnv(secrets);
  if (Object.keys(env).length) {
    block += '\n[mcp_servers.loopback.env]\n';
    for (const [k, v] of Object.entries(env)) block += `${k} = ${JSON.stringify(v)}\n`;
  }
  const existing = exists(configPath) ? fs.readFileSync(configPath, 'utf8') : '';
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
  return {
    ingestUrl: opts.ingestUrl || process.env.LOOPBACK_INGEST_URL || '',
    token: opts.token || process.env.LOOPBACK_TOKEN || '',
  };
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
  const secrets = resolveSecrets(opts);
  if (!secrets.ingestUrl || !secrets.token) {
    warn('LOOPBACK_INGEST_URL / LOOPBACK_TOKEN not provided (flags or env). Installing anyway; set them before submitting feedback.');
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
};
