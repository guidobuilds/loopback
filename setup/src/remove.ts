/**
 * Remove flow for `@guidobuilds/loopback-setup`.
 *
 * Mirror of install.ts in reverse — un-registers the MCP server from the
 * chosen agent's config, deletes the feedback-detector skill directory and
 * harness-feedback command file, and (with --all) wipes ~/.loopback/.
 *
 * Pipeline:
 *
 *   1. Resolve the target agent (positional arg or interactive picker).
 *   2. Confirm uninstall (unless --yes).
 *   3. Remove per-agent components, skipping missing pieces gracefully.
 *   4. With --all, also delete ~/.loopback/ (config + MCP bundle).
 *   5. Print a summary listing what was removed (and what was already gone).
 *
 * Legacy plugin cleanup: the previous OpenCode setup wrote a `loopback.ts`
 * plugin that shelled out to `loopback internal *` (CLI commands that no
 * longer exist). The new installer never writes that plugin, but users who
 * upgraded will still have it on disk — we remove it unconditionally here so
 * an old plugin can't end up calling a deleted binary.
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import type { ParsedArgs } from './index.js';
import { BOLD, DIM, RESET, TEXT } from './style.js';
import {
  AGENTS,
  isAgent,
  type Agent,
  detectAgent,
  loopbackDir,
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
import { confirm, select } from './prompts.js';
import {
  exists,
  readJSON,
  writeJSON,
  commandExists,
} from './fs-utils.js';
import { upsertCodexBlock } from './codex-toml.js';

const AGENT_DISPLAY: Record<Agent, string> = {
  'claude-code': 'Claude Code',
  opencode: 'OpenCode',
  codex: 'Codex',
};

/* ------------------------------------------------------------------ *
 * Reporting                                                            *
 * ------------------------------------------------------------------ */

interface RemoveReport {
  agent: Agent;
  /** Components actually removed (path strings) */
  removed: string[];
  /** Components that were not present to begin with (path strings) */
  skipped: string[];
  /** Whether ~/.loopback/ was deleted (with --all) */
  deletedGlobal: boolean;
  /** True if --all was NOT passed and ~/.loopback/ remains on disk */
  keptGlobal: boolean;
  warnings: string[];
}

/* ------------------------------------------------------------------ *
 * Step 1: agent selection                                              *
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

  const choices = AGENTS.map((a) => {
    const detected = detectAgent(a);
    return {
      value: a,
      label: AGENT_DISPLAY[a],
      hint: detected ? '(detected)' : '(not detected)',
      disabled: false,
    };
  });
  choices.sort(
    (a, b) => Number(b.hint === '(detected)') - Number(a.hint === '(detected)')
  );

  return await select(
    'Which agent do you want to remove loopback from?',
    choices
  );
}

/* ------------------------------------------------------------------ *
 * Step 3: per-agent removal helpers                                    *
 * ------------------------------------------------------------------ */

/** Best-effort recursive delete. Returns true iff something was removed. */
function rmIfExists(p: string): boolean {
  if (!exists(p)) return false;
  try {
    fs.rmSync(p, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

/**
 * Remove the `loopback` entry from a Claude Code config file (JSON). Returns
 * true iff the entry was present and removed. The file itself is preserved
 * even if `mcpServers` becomes empty — we don't own that file's lifecycle.
 */
function removeMcpFromClaudeConfig(filePath: string): boolean {
  if (!exists(filePath)) return false;
  let data: { mcpServers?: Record<string, unknown> };
  try {
    data = readJSON<{ mcpServers?: Record<string, unknown> }>(filePath);
  } catch {
    return false;
  }
  if (!data.mcpServers || !Object.prototype.hasOwnProperty.call(data.mcpServers, 'loopback')) {
    return false;
  }
  delete data.mcpServers.loopback;
  writeJSON(filePath, data);
  return true;
}

function removeClaudeCode(report: RemoveReport): void {
  // 1. MCP registration. Try the CLI first; if that fails (or claude isn't
  // on PATH), fall back to direct edits of ~/.claude.json and
  // ~/.claude/settings.json. Any one of these paths is a valid surface.
  let mcpRemoved = false;
  if (commandExists('claude')) {
    try {
      execFileSync('claude', ['mcp', 'remove', 'loopback', '-s', 'user'], {
        stdio: 'ignore',
      });
      mcpRemoved = true;
    } catch {
      /* fall through to manual edit */
    }
  }
  // Always also sweep the on-disk files — `claude mcp remove` doesn't
  // necessarily clean every location, and an upgrader may have entries in
  // both places.
  const userConfig = path.join(claudeDir(), '..', '.claude.json');
  if (removeMcpFromClaudeConfig(userConfig)) mcpRemoved = true;
  const settings = path.join(claudeDir(), 'settings.json');
  if (removeMcpFromClaudeConfig(settings)) mcpRemoved = true;

  if (mcpRemoved) {
    report.removed.push(`${userConfig} (MCP entry)`);
  } else {
    report.skipped.push(`${userConfig} (MCP entry)`);
  }

  // 2. Skill directory.
  const skillDir = claudeSkillDir();
  if (rmIfExists(skillDir)) report.removed.push(skillDir);
  else report.skipped.push(skillDir);

  // 3. Slash-command file.
  const cmdFile = claudeCommandPath();
  if (rmIfExists(cmdFile)) report.removed.push(cmdFile);
  else report.skipped.push(cmdFile);
}

function removeOpenCode(report: RemoveReport): void {
  // 1. MCP entry in opencode.jsonc / opencode.json.
  const cp = exists(opencodeJsoncPath()) ? opencodeJsoncPath() : opencodeJsonPath();
  let mcpRemoved = false;
  if (exists(cp)) {
    try {
      const cfg = readJSON<{ mcp?: Record<string, unknown> }>(cp);
      if (cfg.mcp && Object.prototype.hasOwnProperty.call(cfg.mcp, 'loopback')) {
        delete (cfg.mcp as Record<string, unknown>).loopback;
        writeJSON(cp, cfg);
        mcpRemoved = true;
      }
    } catch {
      report.warnings.push(`failed to update ${cp}`);
    }
  }
  if (mcpRemoved) report.removed.push(`${cp} (MCP entry)`);
  else report.skipped.push(`${cp} (MCP entry)`);

  // 2. Legacy plugin (the new installer doesn't write this, but an upgrader
  // will still have it on disk — and it shells out to deleted CLI commands).
  const pluginPath = path.join(opencodeDir(), 'plugins', 'loopback.ts');
  if (rmIfExists(pluginPath)) report.removed.push(pluginPath);
  else report.skipped.push(pluginPath);

  // 3. Skill directory.
  const skillDir = opencodeSkillDir();
  if (rmIfExists(skillDir)) report.removed.push(skillDir);
  else report.skipped.push(skillDir);

  // 4. Slash-command file.
  const cmdFile = opencodeCommandPath();
  if (rmIfExists(cmdFile)) report.removed.push(cmdFile);
  else report.skipped.push(cmdFile);
}

function removeCodex(report: RemoveReport): void {
  // 1. [mcp_servers.loopback] block in ~/.codex/config.toml.
  const cp = codexConfigPath();
  let mcpRemoved = false;
  if (exists(cp)) {
    const before = fs.readFileSync(cp, 'utf8');
    if (/\[mcp_servers\.loopback\b/.test(before)) {
      // upsertCodexBlock('', '') with no replacement block strips every
      // existing [mcp_servers.loopback...] section.
      const after = upsertCodexBlock(before, '').trim();
      // Preserve a trailing newline; if the file becomes empty, leave it as
      // an empty file rather than deleting it (the user owns the file).
      fs.writeFileSync(cp, after.length > 0 ? after + '\n' : '');
      mcpRemoved = true;
    }
  }
  if (mcpRemoved) report.removed.push(`${cp} ([mcp_servers.loopback])`);
  else report.skipped.push(`${cp} ([mcp_servers.loopback])`);

  // 2. Skill directory (under ~/.agents/, shared multi-agent dir).
  const skillDir = codexSkillDir();
  if (rmIfExists(skillDir)) report.removed.push(skillDir);
  else report.skipped.push(skillDir);

  // 3. Slash-command file (~/.codex/prompts/harness-feedback.md).
  const cmdFile = codexCommandPath();
  if (rmIfExists(cmdFile)) report.removed.push(cmdFile);
  else report.skipped.push(cmdFile);
}

/* ------------------------------------------------------------------ *
 * Entry point                                                          *
 * ------------------------------------------------------------------ */

export async function runRemove(args: ParsedArgs): Promise<void> {
  // 1. Resolve agent.
  const agent = await resolveAgent(args);

  // 2. Confirm uninstall (unless --yes).
  if (!args.yes) {
    const proceed = await confirm(
      `Remove loopback from ${AGENT_DISPLAY[agent]}?`,
      false
    );
    if (!proceed) {
      console.log(`${DIM}Cancelled.${RESET}`);
      return;
    }
  }

  // 3. Per-agent removal.
  const report: RemoveReport = {
    agent,
    removed: [],
    skipped: [],
    deletedGlobal: false,
    keptGlobal: false,
    warnings: [],
  };

  switch (agent) {
    case 'claude-code':
      removeClaudeCode(report);
      break;
    case 'opencode':
      removeOpenCode(report);
      break;
    case 'codex':
      removeCodex(report);
      break;
  }

  // 4. Optional global cleanup.
  if (args.all) {
    const gp = loopbackDir();
    if (rmIfExists(gp)) {
      report.removed.push(gp);
      report.deletedGlobal = true;
    } else {
      report.skipped.push(gp);
    }
  } else if (exists(loopbackDir())) {
    report.keptGlobal = true;
  }

  // 5. Summary.
  printSummary(report);
}

/* ------------------------------------------------------------------ *
 * Summary                                                              *
 * ------------------------------------------------------------------ */

function printSummary(r: RemoveReport): void {
  console.log();
  console.log(
    `${TEXT}✓${RESET} Removed ${BOLD}loopback${RESET} from ${BOLD}${AGENT_DISPLAY[r.agent]}${RESET}`
  );
  console.log();
  for (const f of dedupe(r.removed)) {
    console.log(`  ${DIM}${tildeify(f)}${RESET}`);
  }
  for (const f of dedupe(r.skipped)) {
    console.log(`  ${DIM}${tildeify(f)} (not installed)${RESET}`);
  }
  console.log();

  if (r.warnings.length > 0) {
    console.log(`${BOLD}Warnings:${RESET}`);
    for (const w of r.warnings) {
      console.log(`  ${DIM}!${RESET} ${w}`);
    }
    console.log();
  }

  if (r.keptGlobal) {
    console.log(
      `${DIM}Note: credentials at ~/.loopback/config.json kept. Use --all to remove.${RESET}`
    );
    console.log();
  }
}

function dedupe<T>(xs: readonly T[]): T[] {
  return Array.from(new Set(xs));
}

function tildeify(p: string): string {
  const h = process.env.HOME;
  if (h && p.startsWith(h + path.sep)) return '~' + p.slice(h.length);
  return p;
}
