/**
 * Unit tests for `setup/src/style.ts` and `setup/src/detect-agent.ts`.
 * Runs under Node's built-in test runner (`node --test`); no framework.
 * Imports the tsup-compiled ESM library entries from `../dist/`.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  RESET,
  BOLD,
  DIM,
  TEXT,
  GRAYS,
  LOGO_LINES,
  showLogo,
  showBanner,
} from '../dist/style.js';
import { isRunningInAgent } from '../dist/detect-agent.js';

test('style: ANSI constants are non-empty escape sequences', () => {
  for (const [name, val] of Object.entries({ RESET, BOLD, DIM, TEXT })) {
    assert.equal(typeof val, 'string', `${name} is a string`);
    assert.ok(val.length > 0, `${name} is non-empty`);
    assert.ok(val.startsWith('\x1b['), `${name} starts with CSI`);
  }
});

test('style: GRAYS is a 6-step gradient', () => {
  assert.ok(Array.isArray(GRAYS), 'GRAYS is an array');
  assert.equal(GRAYS.length, 6);
  for (const g of GRAYS) {
    assert.ok(g.startsWith('\x1b[38;5;'), 'each gray is a 256-color SGR');
  }
});

test('style: LOGO_LINES is 6 non-empty strings', () => {
  assert.equal(LOGO_LINES.length, 6);
  for (const line of LOGO_LINES) {
    assert.equal(typeof line, 'string');
    assert.ok(line.length > 0);
  }
});

test('style: showLogo() writes every LOGO line to stdout', () => {
  const chunks = [];
  const origWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk) => {
    chunks.push(typeof chunk === 'string' ? chunk : chunk.toString('utf8'));
    return true;
  };
  try {
    showLogo();
  } finally {
    process.stdout.write = origWrite;
  }
  const out = chunks.join('');
  for (const line of LOGO_LINES) {
    assert.ok(out.includes(line), `output must include LOGO line: ${line.slice(0, 20)}…`);
  }
});

test('style: showBanner() includes tagline + try line', () => {
  const chunks = [];
  const origWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk) => {
    chunks.push(typeof chunk === 'string' ? chunk : chunk.toString('utf8'));
    return true;
  };
  try {
    showBanner();
  } finally {
    process.stdout.write = origWrite;
  }
  const out = chunks.join('');
  assert.ok(out.includes('The harness-agnostic feedback loop'), 'tagline present');
  assert.ok(out.includes('try:'), 'try-line present');
  assert.ok(out.includes('npx @loopback/setup'), 'npx hint present');
});

test('detect-agent: returns true when AI_AGENT is set, false when no agent env is set', () => {
  // Save + clear all agent env vars to make this deterministic.
  const VARS = ['CLAUDECODE', 'CLAUDE_CODE', 'OPENCODE', 'OPENCODE_HARNESS', 'CODEX', 'AI_AGENT'];
  const saved = {};
  for (const k of VARS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  try {
    assert.equal(isRunningInAgent(), false, 'no agent env → false');

    process.env.AI_AGENT = 'claude-code_2-1-150_agent';
    assert.equal(isRunningInAgent(), true, 'AI_AGENT set → true');
    delete process.env.AI_AGENT;
    assert.equal(isRunningInAgent(), false, 'AI_AGENT cleared → false again');

    process.env.OPENCODE = '1';
    assert.equal(isRunningInAgent(), true, 'OPENCODE set → true');
    delete process.env.OPENCODE;

    process.env.CLAUDECODE = '1';
    assert.equal(isRunningInAgent(), true, 'CLAUDECODE set → true');
    delete process.env.CLAUDECODE;

    process.env.CODEX = '1';
    assert.equal(isRunningInAgent(), true, 'CODEX set → true');
    delete process.env.CODEX;
  } finally {
    for (const k of VARS) {
      if (saved[k] !== undefined) process.env[k] = saved[k];
      else delete process.env[k];
    }
  }
});

test('detect-agent: empty-string env values do NOT count as in-agent', () => {
  const VARS = ['CLAUDECODE', 'CLAUDE_CODE', 'OPENCODE', 'OPENCODE_HARNESS', 'CODEX', 'AI_AGENT'];
  const saved = {};
  for (const k of VARS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  try {
    process.env.AI_AGENT = '';
    assert.equal(isRunningInAgent(), false, 'empty AI_AGENT must not trigger detection');
  } finally {
    for (const k of VARS) {
      if (saved[k] !== undefined) process.env[k] = saved[k];
      else delete process.env[k];
    }
  }
});
