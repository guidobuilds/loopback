'use strict';
/*
 * config (core) — single source of truth for loopback credentials
 * (LOOPBACK_INGEST_URL / LOOPBACK_TOKEN), harness-agnostic.
 *
 * Engram-style: persist once to a fixed path, let env vars / CLI flags override
 * per-session or per-invocation. The MCP server and the CLI both go through
 * `resolveCredentials({ flagToken, flagUrl })` so precedence is identical
 * everywhere:
 *
 *   1. CLI flag (--token, --ingest-url)
 *   2. process.env.LOOPBACK_TOKEN / LOOPBACK_INGEST_URL
 *   3. ~/.loopback/config.json
 *   4. undefined (caller decides: error in CLI, skip-post in MCP)
 *
 * Path is fixed at ~/.loopback/config.json (NOT under <data-dir>, because
 * data-dir resolves to a different location per-harness — that would break the
 * "one file for all harnesses" promise). Stdlib only; mirrors core/data-dir.js
 * in style.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const SCHEMA_VERSION = 1;

function home() {
  return process.env.HOME || os.homedir();
}

// Fixed path. Deliberately NOT derived from resolveDataDir() — credentials must
// live at a single harness-agnostic location.
function configDir() {
  return path.join(home(), '.loopback');
}
function configPath() {
  return path.join(configDir(), 'config.json');
}

// Return the persisted config, or {} if missing/unreadable/invalid. Never
// throws — callers fall through to env/flag precedence.
function loadConfig() {
  let raw;
  try {
    raw = fs.readFileSync(configPath(), 'utf8');
  } catch (_) {
    return {};
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (_) {
    return {};
  }
  if (!parsed || typeof parsed !== 'object') return {};
  return parsed;
}

// Merge-write: read existing, overlay only fields the caller provided (string,
// non-empty), bump schemaVersion, write with 0600 / dir 0700. Silently no-op
// on permission errors (best-effort persistence — env/flag still work).
function saveConfig(next) {
  const current = loadConfig();
  const merged = Object.assign({}, current, { schemaVersion: SCHEMA_VERSION });
  if (next && typeof next === 'object') {
    if (typeof next.ingestUrl === 'string' && next.ingestUrl.length > 0) {
      merged.ingestUrl = next.ingestUrl;
    }
    if (typeof next.token === 'string' && next.token.length > 0) {
      merged.token = next.token;
    }
  }
  const dir = configDir();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  // Best-effort chmod the dir to 0700 even if it already existed.
  try {
    if (process.platform !== 'win32') fs.chmodSync(dir, 0o700);
  } catch (_) {
    /* ignore */
  }
  const body = JSON.stringify(merged, null, 2) + '\n';
  fs.writeFileSync(configPath(), body, { mode: 0o600 });
  // chmod again in case the file already existed with looser perms.
  try {
    if (process.platform !== 'win32') fs.chmodSync(configPath(), 0o600);
  } catch (_) {
    /* ignore */
  }
  return merged;
}

// The one entry point callers should use. `opts` is `{ flagToken, flagUrl }`;
// any field can be omitted. Returns `{ ingestUrl, token }` where each may be
// undefined when no source supplied it.
function resolveCredentials(opts) {
  opts = opts || {};
  const file = loadConfig();
  const ingestUrl = pickString(opts.flagUrl) || pickString(process.env.LOOPBACK_INGEST_URL) || pickString(file.ingestUrl) || undefined;
  const token = pickString(opts.flagToken) || pickString(process.env.LOOPBACK_TOKEN) || pickString(file.token) || undefined;
  return { ingestUrl, token };
}

function pickString(v) {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

module.exports = {
  configPath,
  configDir,
  loadConfig,
  saveConfig,
  resolveCredentials,
  SCHEMA_VERSION,
};
