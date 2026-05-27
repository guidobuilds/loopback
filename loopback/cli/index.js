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
 * Data dir resolution honors LOOPBACK_DATA_DIR (and the Claude Code / XDG
 * fallbacks); see core/data-dir.js.
 */
'use strict';

const fs = require('fs');
const core = require('../core');

const DATA_DIR = core.resolveDataDir();

function readStdin() {
  try {
    return fs.readFileSync(0, 'utf8');
  } catch (_) {
    return '';
  }
}

function flag(argv, name) {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
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
      const sub = rest[0];
      if (sub === '--list') {
        process.stdout.write(JSON.stringify({ schemaVersion: 1, muted: core.mutes.listMutes(DATA_DIR) }) + '\n');
        return;
      }
      if (sub === '--is-muted') {
        const id = rest[1];
        if (!id) return usage('mute --is-muted <id>');
        const muted = core.mutes.isMuted(DATA_DIR, id);
        process.stdout.write((muted ? 'muted' : 'not-muted') + '\n');
        process.exit(muted ? 0 : 1);
      }
      if (sub === '--unmute') {
        const id = rest[1];
        if (!id) return usage('mute --unmute <id>');
        core.mutes.unmute(DATA_DIR, id);
        process.stdout.write('unmuted ' + id + '\n');
        return;
      }
      if (!sub || sub.startsWith('--')) return usage('mute <id> | --is-muted <id> | --list | --unmute <id>');
      core.mutes.mute(DATA_DIR, sub);
      process.stdout.write('muted ' + sub + '\n');
      return;
    }

    case 'scan-correction': {
      const input = rest.length > 0 ? rest.join(' ') : readStdin();
      const hit = core.turnState.scanCorrection(input);
      process.stdout.write((hit ? 'hit' : 'miss') + '\n');
      process.exit(hit ? 0 : 1);
    }

    case 'record-write': {
      core.turnState.recordWrite(DATA_DIR, flag(rest, '--session'), flag(rest, '--file'));
      process.stdout.write('ok\n');
      return;
    }

    case 'bump-correction': {
      const count = core.turnState.bumpCorrection(DATA_DIR, flag(rest, '--session'));
      process.stdout.write(String(count) + '\n');
      return;
    }

    case 'turn-state': {
      const session = flag(rest, '--session');
      const state = core.turnState.readState(DATA_DIR, session);
      process.stdout.write(JSON.stringify({ state, primed: core.turnState.isPrimed(state) }) + '\n');
      return;
    }

    case 'list': {
      // Read stored feedback back from the admin-only GET /feedback. Async HTTP
      // (native fetch); the subcommand owns its own exit codes / error messages.
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
      // (prints resolved values with the token redacted). Lazy-required to
      // keep top-level imports cheap.
      const show = rest.includes('--show');
      if (show) {
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
      const opts = { harnesses: [], serviceUrl: undefined, token: undefined };
      for (let i = 0; i < rest.length; i++) {
        const a = rest[i];
        if (a === '--service-url') opts.serviceUrl = rest[++i];
        else if (a === '--token') opts.token = rest[++i];
        else if (a === '--automatic-feedback-detection') opts.automaticFeedbackDetection = true;
        else if (a === '--all' || a.startsWith('-')) continue;
        else opts.harnesses.push(a);
      }
      setupMod.setup(opts);
      return;
    }

    case 'uninstall': {
      const setupMod = require('./setup');
      const opts = { harnesses: [], serviceUrl: undefined, token: undefined };
      for (let i = 0; i < rest.length; i++) {
        const a = rest[i];
        if (a === '--service-url') opts.serviceUrl = rest[++i];
        else if (a === '--token') opts.token = rest[++i];
        else if (a === '--all' || a.startsWith('-')) continue;
        else opts.harnesses.push(a);
      }
      setupMod.uninstall(opts);
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
        'config [harness...] [--service-url URL] [--token TOK] | config --show | ' +
        'uninstall [harness...] | ' +
        'list [--format table|json] [--all] [--limit N] [--offset N] [--artifact ID] ' +
        '[--severity low|medium|high] [--confidence low|medium|high] [--email ADDR] ' +
        '[--from ISO] [--to ISO] [--service-url URL] [--token TOK] | ' +
        'redact | data-dir | mute | scan-correction | record-write | bump-correction | turn-state') +
      '\n'
  );
  process.exit(2);
}

main();
