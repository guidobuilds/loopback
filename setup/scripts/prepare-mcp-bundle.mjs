#!/usr/bin/env node
/**
 * Copy the loopback MCP server bundle + skill + slash command into
 * setup/mcp-bundle/ before tsup builds the installer.
 *
 * Layout produced:
 *   setup/mcp-bundle/server.bundle.js
 *   setup/mcp-bundle/skills/feedback-detector/...
 *   setup/mcp-bundle/commands/harness-feedback.md
 *
 * Why a separate script (not a tsup plugin): keeps tsup config trivial,
 * and makes the dev-vs-publish dependency explicit (loopback/mcp/server.bundle.js
 * is the input artifact — if it's missing, fail loudly).
 *
 * Source paths are resolved relative to this script, so the script works
 * from any cwd.
 */

import { cpSync, existsSync, mkdirSync, rmSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url)); // setup/scripts/
const setupRoot = resolve(here, '..');                 // setup/
const repoRoot = resolve(setupRoot, '..');             // <repo>/
const loopbackRoot = resolve(repoRoot, 'loopback');

const SRC_BUNDLE = resolve(loopbackRoot, 'mcp', 'server.bundle.js');
const SRC_SKILL = resolve(loopbackRoot, 'skills', 'feedback-detector');
const SRC_CMD = resolve(loopbackRoot, 'commands', 'harness-feedback.md');

const DEST_DIR = resolve(setupRoot, 'mcp-bundle');
const DEST_BUNDLE = resolve(DEST_DIR, 'server.bundle.js');
const DEST_SKILL = resolve(DEST_DIR, 'skills', 'feedback-detector');
const DEST_CMD = resolve(DEST_DIR, 'commands', 'harness-feedback.md');

function requireSrc(p, label) {
  if (!existsSync(p)) {
    process.stderr.write(
      `prepare-mcp-bundle: missing ${label} at ${p}\n` +
        `  Run \`pnpm -C ../loopback build\` first to produce the MCP bundle, ` +
        `or fetch the loopback/ sibling package.\n`
    );
    process.exit(1);
  }
}

requireSrc(SRC_BUNDLE, 'MCP server bundle');
requireSrc(SRC_SKILL, 'feedback-detector skill');
requireSrc(SRC_CMD, 'harness-feedback command');

// Clean destination so a removed file in the source doesn't linger here.
if (existsSync(DEST_DIR)) {
  rmSync(DEST_DIR, { recursive: true, force: true });
}
mkdirSync(DEST_DIR, { recursive: true });
mkdirSync(dirname(DEST_BUNDLE), { recursive: true });
mkdirSync(dirname(DEST_SKILL), { recursive: true });
mkdirSync(dirname(DEST_CMD), { recursive: true });

cpSync(SRC_BUNDLE, DEST_BUNDLE);
cpSync(SRC_SKILL, DEST_SKILL, { recursive: true });
cpSync(SRC_CMD, DEST_CMD);

const bundleSize = statSync(DEST_BUNDLE).size;
process.stdout.write(
  `prepare-mcp-bundle: copied bundle (${(bundleSize / 1024).toFixed(1)} KB) + skill + command into ${DEST_DIR}\n`
);
