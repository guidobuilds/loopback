'use strict';
/*
 * `loopback auth` — credentials writer + inspector.
 *
 * The single command that writes to ~/.loopback/config.json. All other
 * commands (`setup <harness>`, `feedback list`, the MCP server) read from
 * that file via core.config.resolveCredentials and never accept per-command
 * credential flags.
 *
 *   loopback auth --service-url URL --token TOK     # write/rotate
 *   loopback auth --token TOK                       # rotate token only
 *   loopback auth --show                            # inspect (token redacted)
 */

const core = require('../core');

function redactToken(t) {
  const s = String(t || '');
  if (s.length <= 8) return '*'.repeat(s.length);
  return s.slice(0, 4) + '*'.repeat(s.length - 4);
}

function showAuth() {
  const file = core.config.loadConfig();
  const resolved = core.config.resolveCredentials({});
  const out = {
    path: core.config.configPath(),
    schemaVersion: file.schemaVersion || null,
    serviceUrl: resolved.serviceUrl || null,
    token: resolved.token ? redactToken(resolved.token) : null,
  };
  process.stdout.write(JSON.stringify(out, null, 2) + '\n');
}

function writeAuth(opts) {
  opts = opts || {};
  if (opts.show) return showAuth();

  const patch = {};
  if (opts.serviceUrl) patch.serviceUrl = opts.serviceUrl;
  if (opts.token) patch.token = opts.token;
  if (Object.keys(patch).length === 0) {
    process.stderr.write(
      'loopback auth: pass --service-url URL and/or --token TOK (or --show to inspect)\n'
    );
    process.exit(2);
  }

  core.config.saveConfig(patch);
  process.stdout.write(`wrote credentials to ${core.config.configPath()} (mode 0600)\n`);
}

module.exports = { writeAuth, showAuth, redactToken };
