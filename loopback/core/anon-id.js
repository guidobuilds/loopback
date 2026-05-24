'use strict';
/*
 * anon-id (core) — stable, opaque, non-reversible per-machine pseudonym (A4).
 *
 * anonUserId = "u_" + hex(HMAC-SHA256(key=salt, msg=machine-id)), where the salt
 * is generated once and persisted in <dataDir>/salt. The salt never leaves the
 * machine and is not part of the id, so the id is non-reversible and is NOT PII.
 *
 * Extracted from the former scripts/anon-id; now takes the resolved dataDir as a
 * parameter instead of reading CLAUDE_PLUGIN_DATA, so it is harness-agnostic.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execSync } = require('child_process');

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function getSalt(dir) {
  const saltPath = path.join(dir, 'salt');
  try {
    const existing = fs.readFileSync(saltPath, 'utf8').trim();
    if (existing.length > 0) return existing;
  } catch (_) {
    /* not yet generated */
  }
  const salt = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(saltPath, salt + '\n', { mode: 0o600 });
  return salt;
}

/* Portable machine fingerprint. Hidden behind the secret salt (it is the HMAC
 * message), so it only needs to be stable, not secret. */
function machineId() {
  for (const p of ['/etc/machine-id', '/var/lib/dbus/machine-id']) {
    try {
      const v = fs.readFileSync(p, 'utf8').trim();
      if (v) return v;
    } catch (_) {
      /* try next */
    }
  }
  try {
    const out = execSync('ioreg -rd1 -c IOPlatformExpertDevice 2>/dev/null', { encoding: 'utf8' });
    const m = out.match(/"IOPlatformUUID"\s*=\s*"([^"]+)"/);
    if (m && m[1]) return m[1];
  } catch (_) {
    /* fall through */
  }
  const ifaces = os.networkInterfaces();
  let mac = '';
  for (const name of Object.keys(ifaces)) {
    for (const ni of ifaces[name] || []) {
      if (!ni.internal && ni.mac && ni.mac !== '00:00:00:00:00:00') {
        mac = ni.mac;
        break;
      }
    }
    if (mac) break;
  }
  return os.hostname() + '|' + mac;
}

// Returns the cached/derived id for this machine, or undefined on hard failure.
function anonUserId(dataDir) {
  try {
    ensureDir(dataDir);
    const cachePath = path.join(dataDir, 'anon-id');
    try {
      const cached = fs.readFileSync(cachePath, 'utf8').trim();
      if (/^u_[0-9a-f]{8,}$/.test(cached)) return cached;
    } catch (_) {
      /* not cached yet */
    }
    const salt = getSalt(dataDir);
    const digest = crypto.createHmac('sha256', salt).update(machineId()).digest('hex');
    const id = 'u_' + digest.slice(0, 32);
    fs.writeFileSync(cachePath, id + '\n', { mode: 0o600 });
    return id;
  } catch (_) {
    return undefined;
  }
}

module.exports = { anonUserId };
