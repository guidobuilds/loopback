#!/usr/bin/env node
/**
 * Sync the canonical feedback-detector skill + /harness-feedback command into
 * the Claude Code plugin tree.
 *
 * The single source of truth is `loopback/skills/feedback-detector/` and
 * `loopback/commands/harness-feedback.md`. A github/path-based plugin install
 * copies only `loopback/plugin/claude-code/`, so the plugin needs COMMITTED
 * physical copies of those assets. This script regenerates them; a companion
 * drift test (loopback/test/plugin-drift.test.mjs) asserts they stay
 * byte-identical.
 *
 * Mirror of setup/scripts/prepare-mcp-bundle.mjs. Source paths resolve relative
 * to this script, so it works from any cwd.
 *
 *   loopback/plugin/claude-code/skills/feedback-detector/...
 *   loopback/plugin/claude-code/commands/harness-feedback.md
 */

import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url)); // loopback/scripts/
const loopbackRoot = resolve(here, '..'); // loopback/

const SRC_SKILL = resolve(loopbackRoot, 'skills', 'feedback-detector');
const SRC_CMD = resolve(loopbackRoot, 'commands', 'harness-feedback.md');

const PLUGIN_ROOT = resolve(loopbackRoot, 'plugin', 'claude-code');
const DEST_SKILL = resolve(PLUGIN_ROOT, 'skills', 'feedback-detector');
const DEST_CMD = resolve(PLUGIN_ROOT, 'commands', 'harness-feedback.md');

function requireSrc(p, label) {
  if (!existsSync(p)) {
    process.stderr.write(`prepare-plugin: missing ${label} at ${p}\n`);
    process.exit(1);
  }
}

requireSrc(SRC_SKILL, 'feedback-detector skill');
requireSrc(SRC_CMD, 'harness-feedback command');

// Clean only the generated copies (never the hand-written hooks/scripts/manifest).
rmSync(DEST_SKILL, { recursive: true, force: true });
rmSync(DEST_CMD, { force: true });

mkdirSync(dirname(DEST_SKILL), { recursive: true });
mkdirSync(dirname(DEST_CMD), { recursive: true });

cpSync(SRC_SKILL, DEST_SKILL, { recursive: true });
cpSync(SRC_CMD, DEST_CMD);

process.stdout.write(
  `prepare-plugin: synced skill + command into ${PLUGIN_ROOT}\n`
);
