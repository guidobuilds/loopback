#!/usr/bin/env node
/*
 * loopback CLI — harness-agnostic entrypoint to @loopback/core for shell-based
 * adapters (hooks/plugins) and manual use. The harness-specific glue (parsing a
 * hook event from stdin, formatting hook output) lives in each adapter; this CLI
 * only exposes the core primitives.
 *
 * User-facing commands:
 *   auth [--service-url URL] [--token TOK] [--show]
 *                                    Write or rotate credentials in
 *                                    ~/.loopback/config.json (the single
 *                                    source of truth). `--show` inspects
 *                                    (token redacted). The only command that
 *                                    accepts --service-url / --token.
 *
 *   setup claude-code [--automatic-feedback-detection]
 *   setup codex
 *   setup opencode                   Idempotent per-harness installer.
 *                                    Requires `auth` to have run first
 *                                    (exits 1 with a hint if not).
 *
 *   feedback list [filters...]       Read stored feedback back via the
 *                                    admin-only GET /feedback. Credentials
 *                                    come from ~/.loopback/config.json
 *                                    (no per-command flag override).
 *
 *   uninstall <harness> | --all      Unwire a named harness (or every
 *                                    detected harness with --all).
 *   redact [text...]                 Redact stdin (or args) -> stdout.
 *   data-dir                         Print the resolved data dir.
 *   mute <id> | --is-muted <id> | --list | --unmute <id>
 *
 * Internal (hook/plugin) commands:
 *   internal scan-correction [text...]
 *   internal record-write --session <id> --file <path>
 *   internal bump-correction --session <id>
 *   internal turn-state --session <id>
 *
 * Flag parsing uses node:util parseArgs (stdlib, no dep added) with strict:true
 * so typos error out instead of being silently dropped. Each (sub)command
 * declares its options in PARSERS.
 *
 * Data dir resolution honors LOOPBACK_DATA_DIR (and the Claude Code / XDG
 * fallbacks); see core/data-dir.js.
 */
'use strict';

const fs = require('fs');
const { parseArgs } = require('node:util');
const core = require('../core');

const DATA_DIR = core.resolveDataDir();

const PARSERS = {
  auth: {
    'service-url': { type: 'string' },
    'token':       { type: 'string' },
    'show':        { type: 'boolean' },
  },
  setup: {
    'automatic-feedback-detection': { type: 'boolean' },
  },
  uninstall: {
    'all': { type: 'boolean' },
  },
  mute: {
    'list':     { type: 'boolean' },
    'is-muted': { type: 'string' },
    'unmute':   { type: 'string' },
  },
  'internal record-write': {
    'session': { type: 'string' },
    'file':    { type: 'string' },
  },
  'internal bump-correction': {
    'session': { type: 'string' },
  },
  'internal turn-state': {
    'session': { type: 'string' },
  },
};

function readStdin() {
  try {
    return fs.readFileSync(0, 'utf8');
  } catch (_) {
    return '';
  }
}

// Wrap parseArgs so a bad flag prints a short, scoped error (with the command
// label) and exits 2 instead of dumping a Node stack trace.
function parse(label, args) {
  try {
    return parseArgs({ args, strict: true, allowPositionals: true, options: PARSERS[label] });
  } catch (err) {
    process.stderr.write('loopback ' + label + ': ' + (err && err.message ? err.message : err) + '\n');
    process.exit(2);
  }
}

function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  const rest = argv.slice(1);

  switch (cmd) {
    case 'auth':       return runAuth(rest);
    case 'setup':      return runSetup(rest);
    case 'feedback':   return runFeedback(rest);
    case 'internal':   return runInternal(rest);
    case 'uninstall':  return runUninstall(rest);
    case 'mute':       return runMute(rest);
    case 'redact':     return runRedact(rest);
    case 'data-dir':   return runDataDir();
    default:           return usage();
  }
}

function runAuth(rest) {
  const { values } = parse('auth', rest);
  require('./auth').writeAuth({
    serviceUrl: values['service-url'],
    token:      values.token,
    show:       values.show,
  });
}

function runSetup(rest) {
  const sub = rest[0];
  const restAfter = rest.slice(1);
  const setupMod = require('./setup');
  if (!sub) {
    return usage('setup ' + setupMod.HARNESSES.join('|') + ' [--automatic-feedback-detection]');
  }
  if (!setupMod.HARNESSES.includes(sub)) {
    process.stderr.write(
      `loopback setup: unknown harness "${sub}" (valid: ${setupMod.HARNESSES.join(', ')})\n`
    );
    process.exit(2);
  }
  const { values } = parse('setup', restAfter);
  try {
    setupMod.installHarness(sub, {
      automaticFeedbackDetection: values['automatic-feedback-detection'],
    });
  } catch (e) {
    if (e && e.code === 'NO_AUTH') {
      process.stderr.write('loopback setup ' + sub + ': ' + e.message + '\n');
      process.exit(1);
    }
    process.stderr.write('loopback setup ' + sub + ': ' + (e && e.message ? e.message : e) + '\n');
    process.exit(1);
  }
}

function runFeedback(rest) {
  const sub = rest[0];
  const restAfter = rest.slice(1);
  if (sub === 'list') {
    require('./feedback')
      .runList(restAfter)
      .catch((err) => {
        process.stderr.write('loopback feedback list: ' + (err && err.message ? err.message : err) + '\n');
        process.exit(1);
      });
    return;
  }
  return usage('feedback list [--format table|json] [--limit N] [--offset N] ' +
    '[--artifact ID] [--severity low|medium|high] [--confidence low|medium|high] ' +
    '[--email ADDR] [--from ISO] [--to ISO] [--all]');
}

function runInternal(rest) {
  const sub = rest[0];
  const restAfter = rest.slice(1);
  switch (sub) {
    case 'scan-correction': {
      const input = restAfter.length > 0 ? restAfter.join(' ') : readStdin();
      const hit = core.turnState.scanCorrection(input);
      process.stdout.write((hit ? 'hit' : 'miss') + '\n');
      process.exit(hit ? 0 : 1);
    }
    case 'record-write': {
      const { values } = parse('internal record-write', restAfter);
      core.turnState.recordWrite(DATA_DIR, values.session, values.file);
      process.stdout.write('ok\n');
      return;
    }
    case 'bump-correction': {
      const { values } = parse('internal bump-correction', restAfter);
      const count = core.turnState.bumpCorrection(DATA_DIR, values.session);
      process.stdout.write(String(count) + '\n');
      return;
    }
    case 'turn-state': {
      const { values } = parse('internal turn-state', restAfter);
      const state = core.turnState.readState(DATA_DIR, values.session);
      process.stdout.write(JSON.stringify({ state, primed: core.turnState.isPrimed(state) }) + '\n');
      return;
    }
    default:
      return usage(
        'internal scan-correction [text...] | ' +
        'internal record-write --session <id> --file <path> | ' +
        'internal bump-correction --session <id> | ' +
        'internal turn-state --session <id>'
      );
  }
}

function runUninstall(rest) {
  const { values, positionals } = parse('uninstall', rest);
  if (!values.all && positionals.length === 0) {
    process.stderr.write(
      'loopback uninstall: pass a harness (claude-code|codex|opencode) or --all\n'
    );
    process.exit(2);
  }
  const setupMod = require('./setup');
  try {
    setupMod.uninstallHarness({ targets: positionals, all: values.all });
  } catch (e) {
    process.stderr.write('loopback uninstall: ' + (e && e.message ? e.message : e) + '\n');
    process.exit(1);
  }
}

function runMute(rest) {
  const { values, positionals } = parse('mute', rest);
  if (values.list) {
    process.stdout.write(JSON.stringify({ schemaVersion: 1, muted: core.mutes.listMutes(DATA_DIR) }) + '\n');
    return;
  }
  if (values['is-muted']) {
    const muted = core.mutes.isMuted(DATA_DIR, values['is-muted']);
    process.stdout.write((muted ? 'muted' : 'not-muted') + '\n');
    process.exit(muted ? 0 : 1);
  }
  if (values.unmute) {
    core.mutes.unmute(DATA_DIR, values.unmute);
    process.stdout.write('unmuted ' + values.unmute + '\n');
    return;
  }
  const id = positionals[0];
  if (!id) return usage('mute <id> | mute --list | mute --is-muted <id> | mute --unmute <id>');
  core.mutes.mute(DATA_DIR, id);
  process.stdout.write('muted ' + id + '\n');
}

function runRedact(rest) {
  const input = rest.length > 0 ? rest.join(' ') : readStdin();
  process.stdout.write(core.redactText(input));
}

function runDataDir() {
  process.stdout.write(DATA_DIR + '\n');
}

function usage(specific) {
  process.stderr.write(
    'loopback ' +
      (specific ||
        'auth [--service-url URL] [--token TOK] [--show] | ' +
        'setup claude-code|codex|opencode [--automatic-feedback-detection] | ' +
        'feedback list [filters...] | ' +
        'uninstall <harness> | uninstall --all | ' +
        'redact | data-dir | ' +
        'mute <id> | mute --list | mute --is-muted <id> | mute --unmute <id> | ' +
        'internal scan-correction | internal record-write --session <id> --file <path> | ' +
        'internal bump-correction --session <id> | internal turn-state --session <id>') +
      '\n'
  );
  process.exit(2);
}

main();
