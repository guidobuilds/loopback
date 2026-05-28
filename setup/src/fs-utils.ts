/**
 * Filesystem helpers shared by install.ts and (future) remove.ts.
 *
 * Two design choices worth knowing:
 *
 *   1. JSON writes are atomic (write-to-temp + rename) so a crashed install
 *      can't corrupt the user's opencode.jsonc or Claude settings.
 *
 *   2. `stripJSONC` is byte-identical to the legacy `loopback/cli/setup.js`
 *      implementation, so opencode.jsonc reads behave exactly the same.
 *      Comments ARE lost on rewrite — same as the legacy installer.
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export function exists(p: string): boolean {
  try {
    fs.accessSync(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Strip `//` line and `/* … *\/` block comments so JSONC files parse with
 * `JSON.parse`. Comments inside string literals are preserved. Mirrors the
 * legacy loopback/cli/setup.js implementation 1:1.
 */
export function stripJSONC(data: string): string {
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

export function readJSON<T = Record<string, unknown>>(p: string): T {
  try {
    return JSON.parse(stripJSONC(fs.readFileSync(p, 'utf8'))) as T;
  } catch {
    return {} as T;
  }
}

/**
 * Atomic JSON write: create the parent dir, write to a sibling `.tmp` file,
 * then rename. A crash mid-write leaves the original file untouched.
 */
export function writeJSON(p: string, obj: unknown, opts?: { mode?: number }): void {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = `${p}.${process.pid}.tmp`;
  const body = JSON.stringify(obj, null, 2) + '\n';
  fs.writeFileSync(tmp, body, opts?.mode != null ? { mode: opts.mode } : undefined);
  if (opts?.mode != null && process.platform !== 'win32') {
    // writeFileSync's `mode` only applies on create. chmod again to cover the
    // case where the tmp file already existed (process restart, etc.).
    try { fs.chmodSync(tmp, opts.mode); } catch { /* best-effort */ }
  }
  fs.renameSync(tmp, p);
}

export function copyDir(src: string, dest: string): void {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.cpSync(src, dest, { recursive: true });
}

export function copyFile(src: string, dest: string): void {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
}

export function commandExists(cmd: string): boolean {
  try {
    execFileSync(process.platform === 'win32' ? 'where' : 'which', [cmd], {
      stdio: 'ignore',
    });
    return true;
  } catch {
    return false;
  }
}
