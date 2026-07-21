// Drift guard + manifest validity for the Claude Code plugin.
//
// The canonical feedback-detector skill + /harness-feedback command live at
// loopback/skills/ and loopback/commands/. The plugin ships COMMITTED copies
// (a github/path plugin install copies only the plugin dir). These tests assert
// the copies are byte-identical to canonical and that the plugin manifests are
// valid and internally consistent. Regenerate copies with:
//   node scripts/prepare-plugin.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url)); // loopback/test/
const root = join(here, '..'); // loopback/
const plugin = join(root, 'plugin', 'claude-code');

function walk(dir) {
  const out = [];
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}

test('plugin skill copy is byte-identical to canonical', () => {
  const src = join(root, 'skills', 'feedback-detector');
  const dst = join(plugin, 'skills', 'feedback-detector');
  const srcFiles = walk(src).map((p) => relative(src, p)).sort();
  const dstFiles = walk(dst).map((p) => relative(dst, p)).sort();
  assert.deepEqual(dstFiles, srcFiles, 'plugin skill file set drifted — run prepare-plugin.mjs');
  for (const rel of srcFiles) {
    assert.deepEqual(
      readFileSync(join(dst, rel)),
      readFileSync(join(src, rel)),
      `plugin copy of ${rel} drifted — run prepare-plugin.mjs`
    );
  }
});

test('plugin command copy is byte-identical to canonical', () => {
  assert.deepEqual(
    readFileSync(join(plugin, 'commands', 'harness-feedback.md')),
    readFileSync(join(root, 'commands', 'harness-feedback.md')),
    'plugin copy of harness-feedback.md drifted — run prepare-plugin.mjs'
  );
});

test('plugin.json and marketplace.json are valid and consistent', () => {
  const manifest = JSON.parse(readFileSync(join(plugin, '.claude-plugin', 'plugin.json'), 'utf8'));
  assert.equal(manifest.name, 'loopback');
  const market = JSON.parse(readFileSync(join(root, '..', '.claude-plugin', 'marketplace.json'), 'utf8'));
  assert.equal(market.name, 'loopback');
  const entry = market.plugins.find((p) => p.name === 'loopback');
  assert.ok(entry, 'marketplace must list the loopback plugin');
  // The source path in the marketplace must resolve to the plugin manifest dir.
  const resolved = join(root, '..', entry.source, '.claude-plugin', 'plugin.json');
  assert.ok(existsSync(resolved), `marketplace source ${entry.source} must point at the plugin`);
});

test('hooks.json is valid and references existing scripts', () => {
  const hooks = JSON.parse(readFileSync(join(plugin, 'hooks', 'hooks.json'), 'utf8'));
  const events = Object.keys(hooks.hooks);
  assert.deepEqual(
    events.sort(),
    ['PostToolUse', 'SessionStart', 'UserPromptSubmit'].sort()
  );
  for (const event of events) {
    for (const group of hooks.hooks[event]) {
      for (const h of group.hooks) {
        assert.equal(h.type, 'command');
        const rel = h.command.replace('${CLAUDE_PLUGIN_ROOT}/', '');
        assert.ok(existsSync(join(plugin, rel)), `hook script ${rel} must exist`);
      }
    }
  }
});
