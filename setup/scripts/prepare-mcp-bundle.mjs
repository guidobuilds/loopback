#!/usr/bin/env node
/**
 * Copy the loopback feedback-detector skill + /harness-feedback command into
 * setup/mcp-bundle/ before tsup builds the installer.
 *
 * The MCP server is now HOSTED BY THE loopback SERVICE (remote MCP). The
 * installer therefore no longer ships a server bundle — it only copies these
 * two assets into the harness and registers the remote MCP endpoint. (The
 * directory name is kept as `mcp-bundle/` for back-compat with setup/.gitignore
 * and the package `files` allowlist; it now holds only skill + command assets.)
 *
 * Layout produced:
 *   setup/mcp-bundle/skills/feedback-detector/...
 *   setup/mcp-bundle/commands/harness-feedback.md
 *
 * Source paths are resolved relative to this script, so it works from any cwd.
 */

import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url)); // setup/scripts/
const setupRoot = resolve(here, '..');                 // setup/
const repoRoot = resolve(setupRoot, '..');             // <repo>/
const loopbackRoot = resolve(repoRoot, 'loopback');

const SRC_SKILL = resolve(loopbackRoot, 'skills', 'feedback-detector');
const SRC_CMD = resolve(loopbackRoot, 'commands', 'harness-feedback.md');

const DEST_DIR = resolve(setupRoot, 'mcp-bundle');
const DEST_SKILL = resolve(DEST_DIR, 'skills', 'feedback-detector');
const DEST_CMD = resolve(DEST_DIR, 'commands', 'harness-feedback.md');

function requireSrc(p, label) {
  if (!existsSync(p)) {
    process.stderr.write(
      `prepare-mcp-bundle: missing ${label} at ${p}\n` +
        `  Fetch the loopback/ sibling package.\n`
    );
    process.exit(1);
  }
}

requireSrc(SRC_SKILL, 'feedback-detector skill');
requireSrc(SRC_CMD, 'harness-feedback command');

// Clean destination so a removed source file doesn't linger here.
if (existsSync(DEST_DIR)) {
  rmSync(DEST_DIR, { recursive: true, force: true });
}
mkdirSync(dirname(DEST_SKILL), { recursive: true });
mkdirSync(dirname(DEST_CMD), { recursive: true });

cpSync(SRC_SKILL, DEST_SKILL, { recursive: true });
cpSync(SRC_CMD, DEST_CMD);

process.stdout.write(
  `prepare-mcp-bundle: copied skill + command into ${DEST_DIR}\n`
);
