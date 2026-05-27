'use strict';
/*
 * config (core) — single source of truth for loopback credentials
 * (LOOPBACK_SERVICE_URL / LOOPBACK_TOKEN), harness-agnostic.
 *
 * The persisted shape is `{ schemaVersion, serviceUrl, token }`. `serviceUrl`
 * is the BASE service URL (e.g. "http://localhost:3000"); endpoint paths like
 * `/feedback` are derived at the call site by `core.wire.endpoint(...)`. That
 * way a new endpoint (`/health`, …) does not require a new persisted field.
 *
 * The MCP server and the CLI both go through `resolveCredentials({ flagToken,
 * flagUrl })` so precedence is identical everywhere:
 *
 *   1. CLI flag (--token, --service-url)
 *   2. process.env.LOOPBACK_TOKEN / LOOPBACK_SERVICE_URL
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

const SCHEMA_VERSION = 2;

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

// Whitelist-write: read existing, overlay only fields the caller provided
// (string, non-empty), then construct the on-disk object from the canonical
// schema fields only (`schemaVersion`, `serviceUrl`, `token`). Anything else
// in the on-disk file is dropped on next write. mode 0600 / dir 0700.
// Silently no-op on permission errors (best-effort persistence — env/flag
// still work).
function saveConfig(next) {
  const current = loadConfig();
  const merged = Object.assign({}, current);
  if (next && typeof next === 'object') {
    if (typeof next.serviceUrl === 'string' && next.serviceUrl.length > 0) {
      merged.serviceUrl = next.serviceUrl;
    }
    if (typeof next.token === 'string' && next.token.length > 0) {
      merged.token = next.token;
    }
  }
  // Whitelist: only known schema fields land on disk. Empty/missing
  // serviceUrl/token are omitted entirely (no empty-string keys).
  const out = {
    schemaVersion: SCHEMA_VERSION,
    ...(typeof merged.serviceUrl === 'string' && merged.serviceUrl.length > 0
      ? { serviceUrl: merged.serviceUrl }
      : {}),
    ...(typeof merged.token === 'string' && merged.token.length > 0
      ? { token: merged.token }
      : {}),
  };
  const dir = configDir();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  // Best-effort chmod the dir to 0700 even if it already existed.
  try {
    if (process.platform !== 'win32') fs.chmodSync(dir, 0o700);
  } catch (_) {
    /* ignore */
  }
  const body = JSON.stringify(out, null, 2) + '\n';
  fs.writeFileSync(configPath(), body, { mode: 0o600 });
  // chmod again in case the file already existed with looser perms.
  try {
    if (process.platform !== 'win32') fs.chmodSync(configPath(), 0o600);
  } catch (_) {
    /* ignore */
  }
  return out;
}

// The one entry point callers should use. `opts` is `{ flagToken, flagUrl }`;
// any field can be omitted. Returns `{ serviceUrl, token }` where each may be
// undefined when no source supplied it.
function resolveCredentials(opts) {
  opts = opts || {};
  const file = loadConfig();
  const serviceUrl = pickString(opts.flagUrl) || pickString(process.env.LOOPBACK_SERVICE_URL) || pickString(file.serviceUrl) || undefined;
  const token = pickString(opts.flagToken) || pickString(process.env.LOOPBACK_TOKEN) || pickString(file.token) || undefined;
  return { serviceUrl, token };
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
