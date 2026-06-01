/**
 * Canonical agent identifiers and the per-agent filesystem layout the
 * installer writes to. Centralized so install.ts and remove.ts (f04) share
 * exactly one source of truth for these paths.
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const AGENTS = ['claude-code', 'opencode', 'codex'] as const;
export type Agent = (typeof AGENTS)[number];

export function isAgent(s: string | undefined): s is Agent {
  return typeof s === 'string' && (AGENTS as readonly string[]).includes(s);
}

export function home(): string {
  return process.env.HOME || os.homedir();
}

/* ---- ~/.loopback/ (shared, harness-agnostic) ---------------------------- */

export function loopbackDir(): string {
  return path.join(home(), '.loopback');
}

export function loopbackConfigPath(): string {
  return path.join(loopbackDir(), 'config.json');
}

/* ---- Claude Code -------------------------------------------------------- */

export function claudeDir(): string {
  return path.join(home(), '.claude');
}

export function claudeSkillDir(): string {
  return path.join(claudeDir(), 'skills', 'feedback-detector');
}

export function claudeCommandPath(): string {
  return path.join(claudeDir(), 'commands', 'harness-feedback.md');
}

/* ---- OpenCode ----------------------------------------------------------- */

export function opencodeDir(): string {
  const xdg = process.env.XDG_CONFIG_HOME;
  return xdg ? path.join(xdg, 'opencode') : path.join(home(), '.config', 'opencode');
}

export function opencodeJsoncPath(): string {
  return path.join(opencodeDir(), 'opencode.jsonc');
}

export function opencodeJsonPath(): string {
  return path.join(opencodeDir(), 'opencode.json');
}

export function opencodeSkillDir(): string {
  return path.join(opencodeDir(), 'skills', 'feedback-detector');
}

export function opencodeCommandPath(): string {
  return path.join(opencodeDir(), 'commands', 'harness-feedback.md');
}

/* ---- Codex -------------------------------------------------------------- */

export function codexDir(): string {
  return path.join(home(), '.codex');
}

export function codexConfigPath(): string {
  return path.join(codexDir(), 'config.toml');
}

export function codexSkillDir(): string {
  // Codex consumes skills from ~/.agents/skills/ (shared multi-agent dir),
  // matching the layout the old `loopback/cli/setup.js` wrote to.
  return path.join(home(), '.agents', 'skills', 'feedback-detector');
}

export function codexCommandPath(): string {
  return path.join(codexDir(), 'prompts', 'harness-feedback.md');
}

/* ---- detection ---------------------------------------------------------- */

/**
 * Cheap CLI-presence check for the agent-selection menu. Uses
 * `which`/`where` because that's what the legacy setup.js did and it
 * works under non-login shells the installer is invoked under.
 */
export function detectAgent(agent: Agent): boolean {
  const which = process.platform === 'win32' ? 'where' : 'which';

  function hasCmd(cmd: string): boolean {
    try {
      execFileSync(which, [cmd], { stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  }
  function hasDir(p: string): boolean {
    try {
      return fs.statSync(p).isDirectory();
    } catch {
      return false;
    }
  }

  switch (agent) {
    case 'claude-code':
      return hasCmd('claude') || hasDir(claudeDir());
    case 'opencode':
      return hasCmd('opencode') || hasDir(opencodeDir());
    case 'codex':
      return hasCmd('codex') || hasDir(codexDir());
  }
}
