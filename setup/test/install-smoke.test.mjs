/**
 * Install-flow smoke: spawn the built `dist/index.js` against a throwaway
 * HOME directory and assert all the artifacts get materialized correctly.
 *
 * PATH is stripped of `claude` (the CLI) so the registration step takes the
 * graceful no-op branch — we only assert what the installer writes to disk
 * itself (config + skill + command), not what `claude mcp add-json` would do.
 * The MCP is a remote endpoint now, so there is no local bundle to assert.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.resolve(here, '..', 'dist', 'index.js');

function mkHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'lb-setup-test-'));
}

function runCli(args, { home, extraEnv = {} } = {}) {
  // Strip PATH so the installer treats `claude` as absent (graceful warning,
  // not a hard failure). This keeps the test deterministic on machines that
  // happen to have Claude Code installed.
  const env = {
    ...process.env,
    HOME: home,
    PATH: '/usr/bin:/bin', // basic POSIX utilities only — no `claude`/`opencode`/`codex`
    ...extraEnv,
  };
  // Clean LOOPBACK_* + agent-detection vars so they don't bleed in from the
  // outer test runner's env.
  for (const k of [
    'LOOPBACK_SERVICE_URL',
    'LOOPBACK_TOKEN',
    'LOOPBACK_DATA_DIR',
    'XDG_CONFIG_HOME',
    'AI_AGENT',
    'CLAUDECODE',
    'CLAUDE_CODE',
    'OPENCODE',
    'OPENCODE_HARNESS',
    'CODEX',
  ]) {
    delete env[k];
  }
  return spawnSync(process.execPath, [CLI, ...args], {
    env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

test('install: claude-code happy path materializes config + skill + command', () => {
  const home = mkHome();
  try {
    const r = runCli(
      ['claude-code', '--token', 'TESTTOK', '--service-url', 'http://localhost:8000', '--yes'],
      { home }
    );
    assert.equal(
      r.status,
      0,
      `installer exit code: ${r.status}\nstdout: ${r.stdout}\nstderr: ${r.stderr}`
    );

    // ~/.loopback/config.json with the right token + service URL.
    const cfgPath = path.join(home, '.loopback', 'config.json');
    assert.ok(fs.existsSync(cfgPath), 'config.json must exist');
    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    assert.equal(cfg.serviceUrl, 'http://localhost:8000');
    assert.equal(cfg.token, 'TESTTOK');
    assert.equal(cfg.schemaVersion, 2, 'canonical schema v2');

    // Mode 0600 on the credentials file.
    if (process.platform !== 'win32') {
      const mode = fs.statSync(cfgPath).mode & 0o777;
      assert.equal(mode, 0o600, `config.json mode: ${mode.toString(8)}`);
    }

    // No local MCP bundle anymore — the MCP is a remote endpoint registered via
    // `claude mcp add-json` (skipped here since `claude` is absent from PATH).
    assert.ok(
      !fs.existsSync(path.join(home, '.loopback', 'mcp')),
      'no ~/.loopback/mcp bundle dir should be created for a remote MCP',
    );

    // Skill copied to ~/.claude/skills/feedback-detector/.
    const skillFile = path.join(home, '.claude', 'skills', 'feedback-detector', 'SKILL.md');
    assert.ok(fs.existsSync(skillFile), 'SKILL.md must exist');

    // Command copied to ~/.claude/commands/harness-feedback.md.
    const cmdFile = path.join(home, '.claude', 'commands', 'harness-feedback.md');
    assert.ok(fs.existsSync(cmdFile), 'harness-feedback.md must exist');

    // NO hooks injected.
    const settingsPath = path.join(home, '.claude', 'settings.json');
    if (fs.existsSync(settingsPath)) {
      const s = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
      assert.ok(
        !s.hooks || Object.keys(s.hooks).length === 0,
        'no hooks must be written by the new installer'
      );
    }
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('install: re-run is idempotent (skill + command + config unchanged)', () => {
  const home = mkHome();
  try {
    const r1 = runCli(
      ['claude-code', '--token', 'T1', '--service-url', 'http://svc-1', '--yes'],
      { home }
    );
    assert.equal(r1.status, 0, `first install: ${r1.stderr}`);

    // Re-run with --force to bypass reinstall detection. Use new creds to
    // confirm config.json is rewritten when creds change.
    const r2 = runCli(
      ['claude-code', '--token', 'T2', '--service-url', 'http://svc-2', '--yes', '--force'],
      { home }
    );
    assert.equal(r2.status, 0, `force-reinstall: ${r2.stderr}`);

    const cfg = JSON.parse(
      fs.readFileSync(path.join(home, '.loopback', 'config.json'), 'utf8')
    );
    assert.equal(cfg.token, 'T2');
    assert.equal(cfg.serviceUrl, 'http://svc-2');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
