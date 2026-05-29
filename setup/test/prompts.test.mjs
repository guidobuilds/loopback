/**
 * Unit tests for `setup/src/prompts.ts`.
 *
 * The prompts module is designed so that non-interactive callers (CI, piped
 * stdin) never block: each primitive falls back to its declared default.
 * These tests assert that contract by mutating `process.stdin.isTTY` to
 * false for the duration of each test.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ask, confirm, select } from '../dist/prompts.js';

function withNonTty(fn) {
  const saved = process.stdin.isTTY;
  // Setting to false is enough — isInteractive() in prompts.ts gates on
  // `Boolean(process.stdin.isTTY)`.
  Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });
  return Promise.resolve(fn()).finally(() => {
    Object.defineProperty(process.stdin, 'isTTY', { value: saved, configurable: true });
  });
}

test('ask(): returns opts.default when stdin is not a TTY', async () => {
  await withNonTty(async () => {
    const v = await ask('Service URL:', { default: 'http://example' });
    assert.equal(v, 'http://example');
  });
});

test('ask(): returns empty string when no default and not required (non-TTY)', async () => {
  await withNonTty(async () => {
    const v = await ask('Optional question:');
    assert.equal(v, '');
  });
});

test('ask(): throws clear error when required and no default (non-TTY)', async () => {
  await withNonTty(async () => {
    await assert.rejects(
      () => ask('Token:', { required: true }),
      /non-interactive: missing required input/
    );
  });
});

test('confirm(): returns defaultYes=true when not a TTY', async () => {
  await withNonTty(async () => {
    const v = await confirm('Proceed?', true);
    assert.equal(v, true);
  });
});

test('confirm(): returns defaultYes=false when not a TTY', async () => {
  await withNonTty(async () => {
    const v = await confirm('Delete ~/.loopback?', false);
    assert.equal(v, false);
  });
});

test('select(): returns first non-disabled choice when not a TTY', async () => {
  await withNonTty(async () => {
    const choices = [
      { value: 'a', label: 'A', disabled: true },
      { value: 'b', label: 'B' },
      { value: 'c', label: 'C' },
    ];
    const v = await select('Pick one:', choices);
    assert.equal(v, 'b', 'first non-disabled is "b"');
  });
});

test('select(): returns first choice when none are disabled (non-TTY)', async () => {
  await withNonTty(async () => {
    const choices = [
      { value: 'claude-code', label: 'Claude Code' },
      { value: 'opencode', label: 'OpenCode' },
      { value: 'codex', label: 'Codex' },
    ];
    const v = await select('Which agent?', choices);
    assert.equal(v, 'claude-code');
  });
});

test('select(): throws when given an empty choices list', async () => {
  await withNonTty(async () => {
    await assert.rejects(() => select('Empty?', []), /choices must be non-empty/);
  });
});
