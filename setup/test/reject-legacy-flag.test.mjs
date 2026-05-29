/**
 * Strict parseArgs gate: the legacy `--automatic-feedback-detection` flag
 * (which used to wire hooks under Claude Code) must be flatly rejected by
 * the new installer. The new architecture has no hooks; if a user pastes
 * the old install command, they should get a clear "unknown option" error
 * — not a silent no-op.
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

function runCli(args, { home } = {}) {
  const env = {
    ...process.env,
    HOME: home,
    PATH: '/usr/bin:/bin',
  };
  for (const k of [
    'LOOPBACK_SERVICE_URL',
    'LOOPBACK_TOKEN',
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

test('rejects --automatic-feedback-detection with non-zero exit + scoped error', () => {
  const home = mkHome();
  try {
    const r = runCli(
      [
        'claude-code',
        '--automatic-feedback-detection',
        '--token',
        'T',
        '--service-url',
        'http://x',
        '--yes',
      ],
      { home }
    );
    assert.notEqual(r.status, 0, `must reject legacy flag; got exit ${r.status}`);
    // node:util parseArgs in strict mode emits a message like:
    //   "Unknown option '--automatic-feedback-detection'"
    assert.match(
      r.stderr,
      /Unknown option|automatic-feedback-detection/i,
      `stderr must mention the unknown flag, got: ${r.stderr}`
    );
    // No partial install happened — config file should not exist.
    assert.equal(
      fs.existsSync(path.join(home, '.loopback', 'config.json')),
      false,
      'no config.json must be written on argv-rejection'
    );
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('rejects an arbitrary unknown flag too', () => {
  const home = mkHome();
  try {
    const r = runCli(['--no-such-flag'], { home });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /Unknown option|no-such-flag/i);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
