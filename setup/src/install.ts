/**
 * Install flow for `@guidobuilds/loopback-setup`.
 *
 * Pipeline (kept linear so each step is easy to audit):
 *
 *   1. Resolve the target agent (positional arg or interactive picker).
 *   2. Resolve credentials (flag override > existing config > prompt).
 *   3. Detect a pre-existing install of loopback into the chosen agent.
 *      If complete, ask `Reinstall? (y/N)`. `--force` skips the prompt.
 *   4. Run the idempotent install steps:
 *        a. Write ~/.loopback/config.json (mode 0600) if credentials changed.
 *        b. Register the REMOTE MCP endpoint (<service>/mcp) + bearer header in
 *           the chosen agent's config (no local bundle — the MCP is now hosted
 *           by the loopback service). The bearer token stays user-scoped and is
 *           NEVER carried in the plugin.
 *        c. Claude Code: install the loopback plugin from the github marketplace
 *           (skill + command + priming hooks) when the `claude plugin` CLI is
 *           available; otherwise fall back to copying the skill + command
 *           (no hooks). OpenCode/Codex: copy the skill + command.
 *   5. Print a green summary of what was written.
 *
 * The plugin's hooks only PRIME the detector (a harness-surface inventory + a
 * per-session write-log); they never decide a defect and never send anything.
 * They are an enhancement on Claude Code, never a hard dependency: without them
 * the skill self-detects exactly as before.
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import type { ParsedArgs } from './index.js';
import { BOLD, DIM, RESET, TEXT } from './style.js';
import {
  AGENTS,
  isAgent,
  type Agent,
  detectAgent,
  loopbackConfigPath,
  PLUGIN_MARKETPLACE_SOURCE,
  PLUGIN_MARKETPLACE_NAME,
  PLUGIN_REF,
  claudeDir,
  claudeSkillDir,
  claudeCommandPath,
  opencodeDir,
  opencodeJsoncPath,
  opencodeJsonPath,
  opencodeSkillDir,
  opencodeCommandPath,
  codexConfigPath,
  codexSkillDir,
  codexCommandPath,
} from './agents.js';
import { ask, confirm, select } from './prompts.js';
import { readConfig, writeConfig, redactToken } from './config.js';
import {
  exists,
  readJSON,
  writeJSON,
  copyDir,
  copyFile,
  commandExists,
} from './fs-utils.js';
import { readCodexEnvBlock, upsertCodexBlock } from './codex-toml.js';

const AGENT_DISPLAY: Record<Agent, string> = {
  'claude-code': 'Claude Code',
  opencode: 'OpenCode',
  codex: 'Codex',
};

/* ------------------------------------------------------------------ *
 * Step 1: agent selection                                             *
 * ------------------------------------------------------------------ */

async function resolveAgent(args: ParsedArgs): Promise<Agent> {
  if (typeof args.agent === 'string' && args.agent.length > 0) {
    if (!isAgent(args.agent)) {
      throw new Error(
        `unknown agent "${args.agent}" (valid: ${AGENTS.join(', ')})`
      );
    }
    return args.agent;
  }

  // Build the interactive picker. Detected agents come first / are the default.
  const choices = AGENTS.map((a) => {
    const detected = detectAgent(a);
    return {
      value: a,
      label: AGENT_DISPLAY[a],
      hint: detected ? '(detected)' : '(not detected)',
      // Don't disable undetected ones — the user may still want to install
      // into a directory the agent will pick up later.
      disabled: false,
    };
  });
  // If at least one was detected, sort detected to the top so the default
  // arrow lands on it.
  choices.sort((a, b) => Number(b.hint === '(detected)') - Number(a.hint === '(detected)'));

  return await select('Which agent do you want to install loopback into?', choices);
}

/* ------------------------------------------------------------------ *
 * Step 2: auth wizard                                                 *
 * ------------------------------------------------------------------ */

interface ResolvedCreds {
  serviceUrl: string;
  token: string;
  /** True iff the config file on disk needs to be (re)written. */
  needsWrite: boolean;
}

async function resolveCreds(args: ParsedArgs): Promise<ResolvedCreds> {
  const existing = readConfig();
  const flagUrl = args.serviceUrl;
  const flagToken = args.token;

  // Flag overrides always win — they bypass every prompt. We still merge with
  // the file so a flag for one field doesn't blank the other.
  if (flagUrl && flagToken) {
    return { serviceUrl: flagUrl, token: flagToken, needsWrite: true };
  }
  if (flagUrl || flagToken) {
    const serviceUrl = flagUrl ?? existing.serviceUrl;
    const token = flagToken ?? existing.token;
    if (serviceUrl && token) {
      return { serviceUrl, token, needsWrite: true };
    }
    // One flag + one missing field → prompt for the missing field.
    const finalUrl =
      serviceUrl ?? (await ask('Service URL:', { required: true }));
    const finalToken =
      token ?? (await ask('Token:', { required: true, silent: true }));
    return { serviceUrl: finalUrl, token: finalToken, needsWrite: true };
  }

  // No flag overrides — branch on what's already on disk.
  const haveUrl = typeof existing.serviceUrl === 'string' && existing.serviceUrl.length > 0;
  const haveToken = typeof existing.token === 'string' && existing.token.length > 0;

  if (haveUrl && haveToken) {
    // Complete config — offer to reuse.
    console.log(
      `${TEXT}✓${RESET} Found existing credentials for ${BOLD}${existing.serviceUrl}${RESET} ${DIM}(token: ${redactToken(existing.token)})${RESET}`
    );
    const keep = args.yes ? true : await confirm('Use these credentials?', true);
    if (keep) {
      return {
        serviceUrl: existing.serviceUrl as string,
        token: existing.token as string,
        needsWrite: false,
      };
    }
    // Re-prompt with the existing values as defaults, then write.
    const url = await ask('Service URL:', {
      default: existing.serviceUrl,
      required: true,
    });
    const tok = await ask('Token:', { silent: true, required: true });
    return { serviceUrl: url, token: tok, needsWrite: true };
  }

  // Partial config — prompt only the missing field.
  const url = haveUrl
    ? (existing.serviceUrl as string)
    : await ask('Service URL:', { required: true });
  const tok = haveToken
    ? (existing.token as string)
    : await ask('Token:', { silent: true, required: true });
  return { serviceUrl: url, token: tok, needsWrite: true };
}

/* ------------------------------------------------------------------ *
 * Step 3: reinstall detection                                         *
 * ------------------------------------------------------------------ */

function isFullyInstalled(agent: Agent): boolean {
  // Fully installed = the MCP server is registered AND the skill + command are
  // present. There is no local bundle anymore (the MCP is a remote endpoint),
  // so registration + assets are the whole check. Any one missing → reinstall.
  switch (agent) {
    case 'claude-code': {
      // Fully installed = MCP registered AND the detector assets are present
      // either as a managed plugin (skill + command + hooks) OR as the legacy
      // copied skill + command (older CLI without `claude plugin`).
      const hasMcp = isClaudeMcpRegistered();
      const hasPlugin = isClaudePluginInstalled();
      const hasSkill = exists(claudeSkillDir());
      const hasCmd = exists(claudeCommandPath());
      return hasMcp && (hasPlugin || (hasSkill && hasCmd));
    }
    case 'opencode': {
      const cp = exists(opencodeJsoncPath()) ? opencodeJsoncPath() : opencodeJsonPath();
      const cfg = exists(cp) ? readJSON<{ mcp?: { loopback?: unknown } }>(cp) : {};
      const hasMcp = !!cfg.mcp?.loopback;
      const hasSkill = exists(opencodeSkillDir());
      const hasCmd = exists(opencodeCommandPath());
      return hasMcp && hasSkill && hasCmd;
    }
    case 'codex': {
      const cp = codexConfigPath();
      const hasMcp =
        exists(cp) && /\[mcp_servers\.loopback\]/.test(fs.readFileSync(cp, 'utf8'));
      const hasSkill = exists(codexSkillDir());
      const hasCmd = exists(codexCommandPath());
      return hasMcp && hasSkill && hasCmd;
    }
  }
}

/**
 * Best-effort check that Claude Code knows about an MCP server named
 * `loopback`. There's no public API; we test a couple of well-known files
 * and fall through to false. (The install step still runs idempotently —
 * a false negative just means we'll try to register again.)
 */
function isClaudeMcpRegistered(): boolean {
  // 1. New Claude Code stores user-scope MCP in ~/.claude.json.
  const claudeUserConfig = path.join(claudeDir(), '..', '.claude.json');
  if (exists(claudeUserConfig)) {
    try {
      const data = readJSON<{ mcpServers?: Record<string, unknown> }>(claudeUserConfig);
      if (data.mcpServers && data.mcpServers.loopback) return true;
    } catch {
      /* fall through */
    }
  }
  // 2. Older builds may have an `mcpServers` block in settings.json.
  const settings = path.join(claudeDir(), 'settings.json');
  if (exists(settings)) {
    try {
      const data = readJSON<{ mcpServers?: Record<string, unknown> }>(settings);
      if (data.mcpServers && data.mcpServers.loopback) return true;
    } catch {
      /* fall through */
    }
  }
  // 3. Last resort: ask the CLI if it's available.
  if (commandExists('claude')) {
    try {
      const out = execFileSync('claude', ['mcp', 'list'], {
        stdio: ['ignore', 'pipe', 'ignore'],
      }).toString();
      if (/^\s*loopback\b/m.test(out)) return true;
    } catch {
      /* fall through */
    }
  }
  return false;
}

/**
 * True iff the `claude plugin` subcommand exists (newer Claude Code). Probed
 * with `--help` under `stdio: 'ignore'` so it can never hang on a prompt.
 */
function hasClaudePluginCli(): boolean {
  if (!commandExists('claude')) return false;
  try {
    execFileSync('claude', ['plugin', '--help'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/** True iff `claude plugin list` reports the loopback plugin as installed. */
function isClaudePluginInstalled(): boolean {
  if (!commandExists('claude')) return false;
  try {
    const out = execFileSync('claude', ['plugin', 'list'], {
      stdio: ['ignore', 'pipe', 'ignore'],
    }).toString();
    // Match the plugin name whether printed bare or as `loopback@loopback`.
    return /(^|[\s@])loopback(@loopback)?(\s|$)/m.test(out);
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ *
 * Step 4: installation actions                                        *
 * ------------------------------------------------------------------ */

interface InstallReport {
  agent: Agent;
  files: string[];
  warnings: string[];
}

function registerMcpClaudeCode(mcpUrl: string, token: string, report: InstallReport): void {
  if (!commandExists('claude')) {
    report.warnings.push(
      'claude CLI not on PATH — skipped MCP registration. Install Claude Code, then re-run the installer to wire up the remote MCP server.'
    );
    return;
  }
  // Remote HTTP MCP: Claude Code sends the static Authorization header on every
  // request. add-json with a `type: "http"` spec is the registration shape.
  const spec = {
    type: 'http',
    url: mcpUrl,
    headers: { Authorization: `Bearer ${token}` },
  };
  // Remove any previous entry first (also clears a stale stdio registration
  // from an older install).
  try {
    execFileSync('claude', ['mcp', 'remove', 'loopback', '-s', 'user'], {
      stdio: 'ignore',
    });
  } catch {
    /* not present yet — fine */
  }
  try {
    execFileSync(
      'claude',
      ['mcp', 'add-json', 'loopback', JSON.stringify(spec), '-s', 'user'],
      { stdio: 'ignore' }
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    report.warnings.push(`claude mcp add-json failed (${msg.split('\n')[0]})`);
    return;
  }
  // We don't know exactly which file Claude Code wrote to (it varies by
  // version), so report the directory it owns.
  report.files.push(path.join(claudeDir(), '..', '.claude.json'));
}

function registerMcpOpenCode(mcpUrl: string, token: string, report: InstallReport): void {
  // Prefer .jsonc if it already exists, otherwise default to .json (the
  // file the legacy installer creates on a fresh OpenCode setup).
  const cp = exists(opencodeJsoncPath()) ? opencodeJsoncPath() : opencodeJsonPath();
  const config = exists(cp) ? readJSON<Record<string, any>>(cp) : {};
  config.mcp = (config.mcp as Record<string, any>) || {};
  const prior = ((config.mcp as Record<string, any>).loopback || {}) as Record<string, any>;
  // Remote MCP: merge any user-added custom headers, but our bearer wins.
  const priorHeaders =
    prior.headers && typeof prior.headers === 'object'
      ? (prior.headers as Record<string, unknown>)
      : {};
  const entry: Record<string, unknown> = {
    type: 'remote',
    url: mcpUrl,
    enabled: true,
    headers: { ...priorHeaders, Authorization: `Bearer ${token}` },
  };
  (config.mcp as Record<string, any>).loopback = entry;
  writeJSON(cp, config);
  report.files.push(cp);
}

function registerMcpCodex(mcpUrl: string, token: string, report: InstallReport): void {
  const configPath = codexConfigPath();
  const existing = exists(configPath) ? fs.readFileSync(configPath, 'utf8') : '';
  const preservedEnv = readCodexEnvBlock(existing);

  // Remote MCP: `url` + a static Authorization header via `http_headers` (an
  // inline TOML table). Self-contained — no env var to export at Codex launch.
  let block =
    '[mcp_servers.loopback]\n' +
    `url = ${JSON.stringify(mcpUrl)}\n` +
    `http_headers = { "Authorization" = ${JSON.stringify('Bearer ' + token)} }\n`;
  if (Object.keys(preservedEnv).length > 0) {
    block += '\n[mcp_servers.loopback.env]\n';
    for (const [k, v] of Object.entries(preservedEnv)) {
      block += `${k} = ${JSON.stringify(v)}\n`;
    }
  }
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, upsertCodexBlock(existing, block));
  report.files.push(configPath);
}

/**
 * Resolve the on-disk path to the feedback-detector skill + harness-feedback
 * command. Both live next to the MCP bundle in the published tarball, under
 * `mcp-bundle/skills/` and `mcp-bundle/commands/`. In dev the prebuild
 * script populates these too.
 */
function bundledSkillDir(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, '..', 'mcp-bundle', 'skills', 'feedback-detector');
}

function bundledCommandFile(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, '..', 'mcp-bundle', 'commands', 'harness-feedback.md');
}

function copyAssetsForAgent(agent: Agent, report: InstallReport): void {
  const skillSrc = bundledSkillDir();
  const cmdSrc = bundledCommandFile();
  if (!exists(skillSrc)) {
    throw new Error(`skill source missing at ${skillSrc} (prebuild step likely failed)`);
  }
  if (!exists(cmdSrc)) {
    throw new Error(`command source missing at ${cmdSrc} (prebuild step likely failed)`);
  }

  switch (agent) {
    case 'claude-code':
      copyDir(skillSrc, claudeSkillDir());
      copyFile(cmdSrc, claudeCommandPath());
      report.files.push(claudeSkillDir(), claudeCommandPath());
      return;
    case 'opencode':
      copyDir(skillSrc, opencodeSkillDir());
      copyFile(cmdSrc, opencodeCommandPath());
      report.files.push(opencodeSkillDir(), opencodeCommandPath());
      return;
    case 'codex':
      copyDir(skillSrc, codexSkillDir());
      copyFile(cmdSrc, codexCommandPath());
      report.files.push(codexSkillDir(), codexCommandPath());
      return;
  }
}

/**
 * Install the loopback plugin on Claude Code via the github marketplace — this
 * brings the feedback-detector skill + /harness-feedback command + the priming
 * hooks as a single managed plugin. Every call uses `stdio: 'ignore'`, so an
 * interactive prompt receives EOF and cannot hang the installer. Returns false
 * (recording a warning) so the caller can fall back to copying the assets.
 */
function installPluginClaudeCode(report: InstallReport): boolean {
  // Add (or refresh) the marketplace. If it already exists the add errors, so
  // fall through to an update; ignore update failures — the install is what
  // matters.
  try {
    execFileSync(
      'claude',
      ['plugin', 'marketplace', 'add', PLUGIN_MARKETPLACE_SOURCE],
      { stdio: 'ignore' }
    );
  } catch {
    try {
      execFileSync(
        'claude',
        ['plugin', 'marketplace', 'update', PLUGIN_MARKETPLACE_NAME],
        { stdio: 'ignore' }
      );
    } catch {
      /* best-effort refresh */
    }
  }
  try {
    execFileSync('claude', ['plugin', 'install', PLUGIN_REF], {
      stdio: 'ignore',
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    report.warnings.push(
      `claude plugin install failed (${msg.split('\n')[0]}) — copied the skill + command without priming hooks instead.`
    );
    return false;
  }
  report.files.push(
    `Claude Code plugin ${PLUGIN_REF} (feedback-detector skill + /harness-feedback + priming hooks)`
  );
  return true;
}

/* ------------------------------------------------------------------ *
 * Entry point                                                          *
 * ------------------------------------------------------------------ */

export async function runInstall(args: ParsedArgs): Promise<void> {
  // 1. Agent.
  const agent = await resolveAgent(args);

  // 2. Credentials.
  const creds = await resolveCreds(args);

  // 3. Reinstall detection.
  if (!args.force && isFullyInstalled(agent)) {
    console.log(
      `${TEXT}✓${RESET} loopback is already installed in ${BOLD}${AGENT_DISPLAY[agent]}${RESET}`
    );
    const proceed = args.yes ? false : await confirm('Reinstall?', false);
    if (!proceed) {
      console.log(`${DIM}No changes made.${RESET}`);
      return;
    }
  }

  // 4. Install actions.
  const report: InstallReport = { agent, files: [], warnings: [] };

  // 4a. Config (atomic, mode 0600). Only write if it changed. ~/.loopback/config.json
  //     remains the installer's single source of truth for the URL + token.
  if (creds.needsWrite) {
    writeConfig({ serviceUrl: creds.serviceUrl, token: creds.token });
    report.files.push(loopbackConfigPath());
  }

  // 4b. Register the REMOTE MCP endpoint (<service>/mcp) + bearer header in the
  //     agent's config. No local bundle — the MCP is hosted by the service.
  const mcpUrl = creds.serviceUrl.replace(/\/+$/, '') + '/mcp';
  switch (agent) {
    case 'claude-code':
      registerMcpClaudeCode(mcpUrl, creds.token, report);
      break;
    case 'opencode':
      registerMcpOpenCode(mcpUrl, creds.token, report);
      break;
    case 'codex':
      registerMcpCodex(mcpUrl, creds.token, report);
      break;
  }

  // 4c. Detector assets.
  //   Claude Code → prefer the managed plugin (skill + command + priming
  //   hooks); fall back to copying the assets if `claude plugin` is
  //   unavailable or the install fails.
  //   OpenCode/Codex → copy the skill + command (they have no equivalent
  //   hook/plugin JSON format; the skill self-detects there as before).
  if (agent === 'claude-code' && hasClaudePluginCli()) {
    const installed = installPluginClaudeCode(report);
    if (!installed) copyAssetsForAgent(agent, report);
  } else {
    copyAssetsForAgent(agent, report);
  }

  // 5. Summary.
  printSummary(report);
}

function printSummary(r: InstallReport): void {
  console.log();
  console.log(
    `${TEXT}✓${RESET} Installed ${BOLD}@guidobuilds/loopback-setup${RESET} for ${BOLD}${AGENT_DISPLAY[r.agent]}${RESET}`
  );
  console.log();
  for (const f of dedupe(r.files)) {
    console.log(`  ${DIM}${tildeify(f)}${RESET}`);
  }
  console.log();

  if (r.warnings.length > 0) {
    console.log(`${BOLD}Warnings:${RESET}`);
    for (const w of r.warnings) {
      console.log(`  ${DIM}!${RESET} ${w}`);
    }
    console.log();
  }

  const nextStep =
    r.agent === 'claude-code'
      ? 'open Claude Code and try /harness-feedback'
      : r.agent === 'opencode'
        ? 'open OpenCode and try /harness-feedback'
        : 'open Codex and try /harness-feedback';
  console.log(`${BOLD}Next:${RESET} ${nextStep}`);
  console.log();
}

function dedupe<T>(xs: readonly T[]): T[] {
  return Array.from(new Set(xs));
}

function tildeify(p: string): string {
  const h = process.env.HOME;
  if (h && p.startsWith(h + path.sep)) return '~' + p.slice(h.length);
  return p;
}
