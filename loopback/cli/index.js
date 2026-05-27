#!/usr/bin/env node
/*
 * loopback CLI — harness-agnostic entrypoint to @loopback/core for shell-based
 * adapters (hooks/plugins) and manual use. The harness-specific glue (parsing a
 * hook event from stdin, formatting hook output) lives in each adapter; this CLI
 * only exposes the core primitives.
 *
 * Commands:
 *   setup / uninstall                wire / unwire each detected harness
 *   config --ingest-url URL --token TOK   write ~/.loopback/config.json (rotation)
 *   config --show                    print resolved credentials (token redacted)
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

    case 'setup':
    case 'uninstall': {
      const setupMod = require('./setup');
      const opts = { harnesses: [], ingestUrl: undefined, token: undefined };
      for (let i = 0; i < rest.length; i++) {
        const a = rest[i];
        if (a === '--ingest-url') opts.ingestUrl = rest[++i];
        else if (a === '--token') opts.token = rest[++i];
        else if (a === '--all' || a.startsWith('-')) continue;
        else opts.harnesses.push(a);
      }
      if (cmd === 'setup') setupMod.setup(opts);
      else setupMod.uninstall(opts);
      return;
    }

    case 'config': {
      // Canonical credentials path. `--show` prints the resolved values
      // (token redacted); otherwise --ingest-url / --token write to
      // ~/.loopback/config.json. Lazy-required to keep top-level imports cheap.
      const show = rest.includes('--show');
      if (show) {
        const file = core.config.loadConfig();
        const out = {
          path: core.config.configPath(),
          schemaVersion: file.schemaVersion || null,
          ingestUrl: file.ingestUrl || null,
          token: file.token ? redactToken(file.token) : null,
        };
        process.stdout.write(JSON.stringify(out, null, 2) + '\n');
        return;
      }
      const ingestUrl = flag(rest, '--ingest-url');
      const token = flag(rest, '--token');
      if (!ingestUrl && !token) {
        return usage('config --ingest-url URL --token TOK | config --show');
      }
      const patch = {};
      if (ingestUrl) patch.ingestUrl = ingestUrl;
      if (token) patch.token = token;
      core.config.saveConfig(patch);
      process.stdout.write(`wrote ${core.config.configPath()} (mode 0600)\n`);
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
        'setup [harness...] [--ingest-url URL] [--token TOK] | uninstall [harness...] | ' +
        'config --ingest-url URL --token TOK | config --show | ' +
        'list [--format table|json] [--all] [--limit N] [--offset N] [--artifact ID] ' +
        '[--severity low|medium|high] [--confidence low|medium|high] [--email ADDR] ' +
        '[--from ISO] [--to ISO] [--ingest-url URL] [--token TOK] | ' +
        'redact | data-dir | mute | scan-correction | record-write | bump-correction | turn-state') +
      '\n'
  );
  process.exit(2);
}

main();
