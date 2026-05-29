/**
 * Remove-flow smoke: install → remove → assert agent-side artifacts are gone,
 * then `--remove --all` deletes ~/.loopback/ too.
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

test('remove (agent only): deletes skill + command, keeps ~/.loopback/', () => {
  const home = mkHome();
  try {
    // 1. Install first.
    const inst = runCli(
      ['claude-code', '--token', 'T', '--service-url', 'http://x', '--yes'],
      { home }
    );
    assert.equal(inst.status, 0, `install: ${inst.stderr}`);
    assert.ok(fs.existsSync(path.join(home, '.claude', 'skills', 'feedback-detector')));
    assert.ok(fs.existsSync(path.join(home, '.loopback')));

    // 2. Remove (without --all).
    const rem = runCli(['--remove', 'claude-code', '--yes'], { home });
    assert.equal(rem.status, 0, `remove: ${rem.stderr}`);

    assert.equal(
      fs.existsSync(path.join(home, '.claude', 'skills', 'feedback-detector')),
      false,
      'skill directory must be gone'
    );
    assert.equal(
      fs.existsSync(path.join(home, '.claude', 'commands', 'harness-feedback.md')),
      false,
      'command file must be gone'
    );
    // ~/.loopback/ stays put by default.
    assert.ok(fs.existsSync(path.join(home, '.loopback')), '~/.loopback kept');
    assert.ok(fs.existsSync(path.join(home, '.loopback', 'config.json')), 'config.json kept');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('remove --all: deletes ~/.loopback/ too', () => {
  const home = mkHome();
  try {
    const inst = runCli(
      ['claude-code', '--token', 'T', '--service-url', 'http://x', '--yes'],
      { home }
    );
    assert.equal(inst.status, 0, `install: ${inst.stderr}`);

    const rem = runCli(['--remove', 'claude-code', '--all', '--yes'], { home });
    assert.equal(rem.status, 0, `remove --all: ${rem.stderr}`);

    assert.equal(
      fs.existsSync(path.join(home, '.loopback')),
      false,
      '~/.loopback must be gone'
    );
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('remove: idempotent — second run after full removal exits 0', () => {
  const home = mkHome();
  try {
    const inst = runCli(
      ['claude-code', '--token', 'T', '--service-url', 'http://x', '--yes'],
      { home }
    );
    assert.equal(inst.status, 0);

    const rem1 = runCli(['--remove', 'claude-code', '--yes'], { home });
    assert.equal(rem1.status, 0);

    const rem2 = runCli(['--remove', 'claude-code', '--yes'], { home });
    assert.equal(
      rem2.status,
      0,
      `second remove should be a graceful no-op: stderr=${rem2.stderr}`
    );
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
