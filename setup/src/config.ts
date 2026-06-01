/**
 * Read/write `~/.loopback/config.json` — the installer's single source of
 * credentials (service URL + token).
 *
 * On-disk schema:
 *   { schemaVersion: 2, serviceUrl: string, token: string }
 *
 * Both fields are optional on disk; the installer prompts for whatever is
 * missing and writes the merged result back atomically with mode 0600.
 */

import fs from 'node:fs';
import path from 'node:path';

import { loopbackConfigPath, loopbackDir } from './agents.js';
import { writeJSON } from './fs-utils.js';

export const CONFIG_SCHEMA_VERSION = 2;

export interface LoopbackConfig {
  schemaVersion?: number;
  serviceUrl?: string;
  token?: string;
}

/**
 * Read `~/.loopback/config.json` if present. Returns `{}` on any failure
 * (missing, unreadable, malformed) — the caller treats absence as "prompt
 * for everything".
 */
export function readConfig(): LoopbackConfig {
  const p = loopbackConfigPath();
  let raw: string;
  try {
    raw = fs.readFileSync(p, 'utf8');
  } catch {
    return {};
  }
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return {};
    return parsed as LoopbackConfig;
  } catch {
    return {};
  }
}

/**
 * Atomically write the canonical config shape with mode 0600. Only the
 * three whitelisted fields land on disk; anything else is dropped.
 */
export function writeConfig(next: { serviceUrl?: string; token?: string }): LoopbackConfig {
  const current = readConfig();
  const merged: LoopbackConfig = { ...current };
  if (typeof next.serviceUrl === 'string' && next.serviceUrl.length > 0) {
    merged.serviceUrl = next.serviceUrl;
  }
  if (typeof next.token === 'string' && next.token.length > 0) {
    merged.token = next.token;
  }
  const out: LoopbackConfig = {
    schemaVersion: CONFIG_SCHEMA_VERSION,
    ...(merged.serviceUrl ? { serviceUrl: merged.serviceUrl } : {}),
    ...(merged.token ? { token: merged.token } : {}),
  };

  // Ensure ~/.loopback exists with 0700.
  const dir = loopbackDir();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') {
    try {
      fs.chmodSync(dir, 0o700);
    } catch {
      /* best-effort */
    }
  }

  writeJSON(loopbackConfigPath(), out, { mode: 0o600 });
  // Belt-and-suspenders: an existing file with looser perms is not chmod'd
  // by writeFileSync's `mode`. The atomic rename in writeJSON lands a new
  // inode created with 0600, so this is mainly defensive.
  if (process.platform !== 'win32') {
    try {
      fs.chmodSync(loopbackConfigPath(), 0o600);
    } catch {
      /* best-effort */
    }
  }
  return out;
}

export function redactToken(t: string | undefined): string {
  const s = String(t || '');
  if (s.length <= 4) return '*'.repeat(s.length);
  return s.slice(0, 4) + '*'.repeat(Math.min(s.length - 4, 4));
}
