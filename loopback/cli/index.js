#!/usr/bin/env node
/*
 * loopback CLI — harness-agnostic entrypoint to @loopback/core for shell-based
 * adapters (hooks/plugins) and manual use. The harness-specific glue (parsing a
 * hook event from stdin, formatting hook output) lives in each adapter; this CLI
 * only exposes the core primitives.
 *
 * Commands:
 *   redact [text...]                 redact stdin (or args) -> stdout
 *   anon-id                          print the stable per-machine pseudonym
 *   data-dir                         print the resolved data dir
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

    case 'anon-id': {
      const id = core.anonUserId(DATA_DIR);
      process.stdout.write((id || '') + '\n');
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

    default:
      return usage();
  }
}

function usage(specific) {
  process.stderr.write(
    'loopback ' +
      (specific ||
        'setup [harness...] [--ingest-url URL] [--token TOK] | uninstall [harness...] | ' +
        'redact | anon-id | data-dir | mute | scan-correction | record-write | bump-correction | turn-state') +
      '\n'
  );
  process.exit(2);
}

main();
