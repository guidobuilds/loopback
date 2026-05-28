#!/usr/bin/env node
/*
 * loopback CLI — harness-agnostic entrypoint to @loopback/core for shell-based
 * adapters (hooks/plugins) and manual use. The harness-specific glue (parsing a
 * hook event from stdin, formatting hook output) lives in each adapter; this CLI
 * only exposes the core primitives.
 *
 * Commands:
 *   config [harness...] [--service-url URL] [--token TOK]
 *                                    one-command installer + credentials writer.
 *                                    Idempotent: first run installs each detected
 *                                    harness and writes ~/.loopback/config.json;
 *                                    later runs re-sync configs and/or rotate
 *                                    credentials. Same verb, every time.
 *   config --show                    print resolved credentials (token redacted)
 *   uninstall [harness...]           unwire each detected (or named) harness
 *   redact [text...]                 redact stdin (or args) -> stdout
 *   data-dir                         print the resolved data dir
 *   list [--format table|json] [filters...]   read stored feedback back (admin token)
 *   mute <id> | --is-muted <id> | --list | --unmute <id>
 *   scan-correction [text...]        exit 0 (+"hit") if correction-language present, else 1 (+"miss")
 *   record-write --session <id> --file <path>
 *   bump-correction --session <id>   print the new re-instruction count
 *   turn-state --session <id>        print the per-session turn-state JSON
 *
 * Flag parsing uses node:util parseArgs (stdlib, no dep added) with strict:true
 * so typos error out instead of being silently dropped. Each subcommand declares
 * its options in PARSERS; usage() must stay in sync (drift-tested separately).
 *
 * Data dir resolution honors LOOPBACK_DATA_DIR (and the Claude Code / XDG
 * fallbacks); see core/data-dir.js.
 */
'use strict';

const fs = require('fs');
const { parseArgs } = require('node:util');
const core = require('../core');

const DATA_DIR = core.resolveDataDir();

// Per-subcommand flag schemas. `list`'s schema lives in cli/list.js next to the
// code that consumes it (and is exported as LIST_OPTIONS for the drift test).
const PARSERS = {
  config: {
    'service-url':                    { type: 'string' },
    'token':                          { type: 'string' },
    'automatic-feedback-detection':   { type: 'boolean' },
    'show':                           { type: 'boolean' },
    'all':                            { type: 'boolean' }, // legacy no-op; accepted for back-compat
  },
  uninstall: {
    'service-url': { type: 'string' },
    'token':       { type: 'string' },
    'all':         { type: 'boolean' }, // legacy no-op; accepted for back-compat
  },
  mute: {
    'list':     { type: 'boolean' },
    'is-muted': { type: 'string' },
    'unmute':   { type: 'string' },
  },
  'record-write': {
    'session': { type: 'string' },
    'file':    { type: 'string' },
  },
  'bump-correction': {
    'session': { type: 'string' },
  },
  'turn-state': {
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

// Wrap parseArgs so a bad flag prints a short, scoped error (with the
// subcommand name) and exits 2 instead of dumping a Node stack trace.
function parse(cmd, args) {
  try {
    return parseArgs({ args, strict: true, allowPositionals: true, options: PARSERS[cmd] });
  } catch (err) {
    process.stderr.write('loopback ' + cmd + ': ' + (err && err.message ? err.message : err) + '\n');
    process.exit(2);
  }
}

function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  const rest = argv.slice(1);

  switch (cmd) {
    case 'redact': {
      const input = rest.length > 0 ? rest.join(' ') : readStdin();
      process.stdout.write(core.redactText(input));
      return;
    }

    case 'data-dir': {
      process.stdout.write(DATA_DIR + '\n');
      return;
    }

    case 'mute': {
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
      if (!id) return usage('mute <id> | --is-muted <id> | --list | --unmute <id>');
      core.mutes.mute(DATA_DIR, id);
      process.stdout.write('muted ' + id + '\n');
      return;
    }

    case 'scan-correction': {
      const input = rest.length > 0 ? rest.join(' ') : readStdin();
      const hit = core.turnState.scanCorrection(input);
      process.stdout.write((hit ? 'hit' : 'miss') + '\n');
      process.exit(hit ? 0 : 1);
    }

    case 'record-write': {
      const { values } = parse('record-write', rest);
      core.turnState.recordWrite(DATA_DIR, values.session, values.file);
      process.stdout.write('ok\n');
      return;
    }

    case 'bump-correction': {
      const { values } = parse('bump-correction', rest);
      const count = core.turnState.bumpCorrection(DATA_DIR, values.session);
      process.stdout.write(String(count) + '\n');
      return;
    }

    case 'turn-state': {
      const { values } = parse('turn-state', rest);
      const state = core.turnState.readState(DATA_DIR, values.session);
      process.stdout.write(JSON.stringify({ state, primed: core.turnState.isPrimed(state) }) + '\n');
      return;
    }

    case 'list': {
      // Read stored feedback back from the admin-only GET /feedback. Async HTTP
      // (native fetch); the subcommand owns its own exit codes / error messages
      // and its own parseArgs call (see cli/list.js).
      require('./list')
        .run(rest)
        .catch((err) => {
          process.stderr.write('loopback list: ' + (err && err.message ? err.message : err) + '\n');
          process.exit(1);
        });
      return;
    }

    case 'config': {
      // Single user-facing entry point for "configure loopback": writes
      // ~/.loopback/config.json (when --service-url/--token are passed) AND
      // wires the MCP server + skill + command + hooks into each detected (or
      // explicitly named) harness. Idempotent — first run installs, later runs
      // re-sync or rotate credentials. `--show` is the read-only inspector
      // (prints resolved values with the token redacted).
      const { values, positionals } = parse('config', rest);
      if (values.show) {
        const file = core.config.loadConfig();
        // Show RESOLVED credentials so an env-only setup is still visible
        // (the resolver applies the same flag > env > file precedence the
        // MCP server / `list` will use at submit/read time).
        const resolved = core.config.resolveCredentials({});
        const out = {
          path: core.config.configPath(),
          schemaVersion: file.schemaVersion || null,
          serviceUrl: resolved.serviceUrl || null,
          token: resolved.token ? redactToken(resolved.token) : null,
        };
        process.stdout.write(JSON.stringify(out, null, 2) + '\n');
        return;
      }
      const setupMod = require('./setup');
      setupMod.setup({
        harnesses: positionals,
        serviceUrl: values['service-url'],
        token: values.token,
        automaticFeedbackDetection: values['automatic-feedback-detection'],
      });
      return;
    }

    case 'uninstall': {
      const { values, positionals } = parse('uninstall', rest);
      const setupMod = require('./setup');
      setupMod.uninstall({
        harnesses: positionals,
        serviceUrl: values['service-url'],
        token: values.token,
      });
      return;
    }

    default:
      return usage();
  }
}

// Redact a token for `loopback config --show`: keep first 4 chars + len marker.
// Never prints the secret in clear; safe for screen-share / paste.
function redactToken(t) {
  const s = String(t || '');
  if (s.length <= 8) return '*'.repeat(s.length);
  return s.slice(0, 4) + '*'.repeat(s.length - 4);
}

function usage(specific) {
  process.stderr.write(
    'loopback ' +
      (specific ||
        'config [harness...] [--service-url URL] [--token TOK] [--automatic-feedback-detection] | ' +
        'config --show | ' +
        'uninstall [harness...] [--service-url URL] [--token TOK] | ' +
        'list [--format table|json] [--all] [--limit N] [--offset N] [--artifact ID] ' +
        '[--severity low|medium|high] [--confidence low|medium|high] [--email ADDR] ' +
        '[--from ISO] [--to ISO] [--service-url URL] [--token TOK] | ' +
        'redact | data-dir | ' +
        'mute <id> | mute --list | mute --is-muted <id> | mute --unmute <id> | ' +
        'scan-correction | ' +
        'record-write --session <id> --file <path> | ' +
        'bump-correction --session <id> | ' +
        'turn-state --session <id>') +
      '\n'
  );
  process.exit(2);
}

main();
