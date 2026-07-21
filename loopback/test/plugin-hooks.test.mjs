// Behavior tests for the plugin's priming hook scripts.
//
// Each hook must: emit valid JSON (or `{}`), NEVER exit non-zero, write only
// local state under ~/.loopback/state/, and degrade to `{}` when jq is absent.
// We run the real scripts with a synthetic stdin payload and a throwaway HOME.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const scripts = join(here, '..', 'plugin', 'claude-code', 'scripts');

function hasJq() {
  try {
    execFileSync('jq', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

// Run a hook script: returns { stdout, status } and never throws on non-zero.
function runHook(name, payload, { home, cwd, stripJq = false } = {}) {
  const env = { ...process.env, HOME: home };
  if (stripJq) {
    // A PATH with coreutils but no jq.
    const bin = join(home, '.fakebin');
    mkdirSync(bin, { recursive: true });
    for (const c of ['sh', 'sed', 'head', 'tr', 'sort', 'paste', 'grep', 'cat', 'date', 'basename', 'dirname']) {
      try {
        const p = execFileSync('command', ['-v', c], { shell: '/bin/sh' }).toString().trim();
        if (p) execFileSync('ln', ['-sf', p, join(bin, c)]);
      } catch { /* skip */ }
    }
    env.PATH = bin;
  }
  try {
    const stdout = execFileSync('sh', [join(scripts, name)], {
      input: payload,
      cwd: cwd ?? home,
      env,
      stdio: ['pipe', 'pipe', 'ignore'],
    }).toString();
    return { stdout, status: 0 };
  } catch (e) {
    return { stdout: (e.stdout ?? '').toString(), status: e.status ?? 1 };
  }
}

function freshHome() {
  const home = mkdtempSync(join(tmpdir(), 'lb-hooks-'));
  mkdirSync(join(home, '.claude', 'skills', 'prd-writer'), { recursive: true });
  mkdirSync(join(home, '.claude', 'agents'), { recursive: true });
  writeFileSync(
    join(home, '.claude', 'skills', 'prd-writer', 'SKILL.md'),
    '---\nname: prd-writer\ndescription: writes PRDs\n---\n# PRD Writer\n'
  );
  writeFileSync(
    join(home, '.claude', 'agents', 'db-migration.md'),
    '---\nname: db-migration\ndescription: migrations\n---\n# DB\n'
  );
  return home;
}

const jq = hasJq();

test('SessionStart builds an inventory naming installed skills + agents', { skip: !jq }, () => {
  const home = freshHome();
  const { stdout, status } = runHook(
    'session-start.sh',
    JSON.stringify({ session_id: 's1', source: 'startup' }),
    { home }
  );
  assert.equal(status, 0);
  const out = JSON.parse(stdout);
  const ctx = out.hookSpecificOutput.additionalContext;
  assert.match(ctx, /prd-writer/);
  assert.match(ctx, /db-migration/);
  const inv = JSON.parse(readFileSync(join(home, '.loopback', 'state', 's1', 'inventory.json'), 'utf8'));
  assert.ok(inv.skills.includes('prd-writer'));
  assert.ok(inv.agents.includes('db-migration'));
  rmSync(home, { recursive: true, force: true });
});

test('PostToolUse appends exactly one write-log line per file write', { skip: !jq }, () => {
  const home = freshHome();
  for (const fp of ['/proj/auth.ts', '/proj/auth.ts']) {
    const { status } = runHook(
      'post-tool-use.sh',
      JSON.stringify({ session_id: 's1', tool_name: 'Write', tool_input: { file_path: fp }, cwd: '/proj' }),
      { home }
    );
    assert.equal(status, 0);
  }
  const log = readFileSync(join(home, '.loopback', 'state', 's1', 'write-log.ndjson'), 'utf8')
    .trim().split('\n');
  assert.equal(log.length, 2);
  assert.equal(JSON.parse(log[0]).file_path, '/proj/auth.ts');
  rmSync(home, { recursive: true, force: true });
});

test('UserPromptSubmit injects on correction, is silent otherwise + debounced', { skip: !jq }, () => {
  const home = freshHome();
  // Seed a write-log so condition (a) holds.
  runHook('post-tool-use.sh', JSON.stringify({ session_id: 's1', tool_name: 'Write', tool_input: { file_path: '/p/a.ts' }, cwd: '/p' }), { home });

  const corrected = runHook('user-prompt-submit.sh', JSON.stringify({ session_id: 's1', prompt: 'No, that is wrong, revert a.ts' }), { home });
  assert.equal(corrected.status, 0);
  assert.match(JSON.parse(corrected.stdout).hookSpecificOutput.additionalContext, /feedback-detector self-check/);

  // Immediate second correction is debounced → silent `{}`.
  const debounced = runHook('user-prompt-submit.sh', JSON.stringify({ session_id: 's1', prompt: 'No, still wrong' }), { home });
  assert.equal(debounced.stdout.trim(), '{}');

  // A non-correction prompt (new session, fresh write-log) stays silent.
  runHook('post-tool-use.sh', JSON.stringify({ session_id: 's2', tool_name: 'Write', tool_input: { file_path: '/p/b.ts' }, cwd: '/p' }), { home });
  const iteration = runHook('user-prompt-submit.sh', JSON.stringify({ session_id: 's2', prompt: 'please add pagination to the endpoint' }), { home });
  assert.equal(iteration.stdout.trim(), '{}');
  rmSync(home, { recursive: true, force: true });
});

test('all hooks degrade to {} and exit 0 when jq is absent', () => {
  const home = freshHome();
  for (const name of ['session-start.sh', 'post-tool-use.sh', 'user-prompt-submit.sh']) {
    const { stdout, status } = runHook(
      name,
      JSON.stringify({ session_id: 'nojq', prompt: 'no wrong', tool_name: 'Write', tool_input: { file_path: '/x/a.ts' } }),
      { home, stripJq: true }
    );
    assert.equal(status, 0, `${name} must exit 0 without jq`);
    assert.equal(stdout.trim(), '{}', `${name} must emit {} without jq`);
  }
  rmSync(home, { recursive: true, force: true });
});
