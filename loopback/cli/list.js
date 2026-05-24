'use strict';
/*
 * `loopback list` — read stored feedback back from the service's admin-only
 * GET /feedback and print it as a compact aligned table (default) or pretty
 * JSON. This is the operator's "review all feedback received" path: filter +
 * paginate the corpus, or `--all --format json > feedback.json` to dump the
 * whole thing for feeding to a coding agent.
 *
 * Dependency-free by design (the CLI is intentionally stdlib-only): the HTTP
 * read lives in core/wire.js (native fetch); this module just maps flags ->
 * query, calls fetchRecords, and renders.
 *
 * Auth: GET /feedback requires an ADMIN token. The token is taken from --token
 * or $LOOPBACK_TOKEN; the URL from --ingest-url or $LOOPBACK_INGEST_URL (the
 * full /feedback URL — GET uses the same URL as POST).
 */

const core = require('../core');

// Flags that carry a value (the rest, like --all, are booleans).
const VALUE_FLAGS = new Set([
  '--format', '--limit', '--offset', '--artifact', '--severity',
  '--confidence', '--email', '--from', '--to', '--ingest-url', '--token',
]);

// Parse argv into an options object. Mirrors the local parsing style in
// cli/index.js (no third-party arg parser). Unknown flags are ignored.
function parseArgs(argv) {
  const opts = { format: 'table', all: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--all') { opts.all = true; continue; }
    if (!VALUE_FLAGS.has(a)) continue;
    const v = argv[++i];
    switch (a) {
      case '--format': opts.format = v; break;
      case '--limit': opts.limit = v; break;
      case '--offset': opts.offset = v; break;
      case '--artifact': opts.artifact = v; break;
      case '--severity': opts.severity = v; break;
      case '--confidence': opts.confidence = v; break;
      case '--email': opts.email = v; break;
      case '--from': opts.from = v; break;
      case '--to': opts.to = v; break;
      case '--ingest-url': opts.ingestUrl = v; break;
      case '--token': opts.token = v; break;
    }
  }
  return opts;
}

// Build the GET /feedback query object from parsed flags. Only set flags are
// included (fetchRecords drops empty values too). `--all` => limit=0 (the
// service's "return everything" escape hatch) and wins over an explicit --limit.
function buildQuery(opts) {
  const q = {};
  if (opts.all) q.limit = 0;
  else if (opts.limit !== undefined) q.limit = opts.limit;
  if (opts.offset !== undefined) q.offset = opts.offset;
  if (opts.artifact !== undefined) q.artifact = opts.artifact;
  if (opts.severity !== undefined) q.severity = opts.severity;
  if (opts.confidence !== undefined) q.confidence = opts.confidence;
  if (opts.email !== undefined) q.email = opts.email;
  if (opts.from !== undefined) q.received_from = opts.from;
  if (opts.to !== undefined) q.received_to = opts.to;
  return q;
}

// Single-line truncation with an ASCII ellipsis (mirrors show_latest_feedback.py
// `_short`). ASCII only so the table renders cleanly in any terminal/pipe.
function short(value, width) {
  if (value === undefined || value === null || value === '') return '-';
  const s = String(value).replace(/\s+/g, ' ').trim();
  if (s.length <= width) return s;
  return s.slice(0, width - 3) + '...';
}

function pad(value, width) {
  const s = String(value);
  return s.length >= width ? s : s + ' '.repeat(width - s.length);
}

// Column widths for the table renderer (RECEIVED ARTIFACT SEV CONF EMAIL SUMMARY).
const COLS = { received: 20, artifact: 18, sev: 6, conf: 6, email: 24, summary: 48 };

function renderTable(records) {
  if (!records || records.length === 0) return 'no records';
  const lines = [];
  lines.push(
    pad('RECEIVED', COLS.received) + '  ' +
    pad('ARTIFACT', COLS.artifact) + '  ' +
    pad('SEV', COLS.sev) + '  ' +
    pad('CONF', COLS.conf) + '  ' +
    pad('EMAIL', COLS.email) + '  ' +
    'SUMMARY'
  );
  for (const r of records) {
    const artifact = r.artifact || {};
    lines.push(
      pad(short(r.timestamp, COLS.received), COLS.received) + '  ' +
      pad(short(artifact.id || artifact.kind, COLS.artifact), COLS.artifact) + '  ' +
      pad(short(r.severity, COLS.sev), COLS.sev) + '  ' +
      pad(short(r.confidence, COLS.conf), COLS.conf) + '  ' +
      pad(short(r.submitterEmail, COLS.email), COLS.email) + '  ' +
      short(r.summary, COLS.summary)
    );
  }
  lines.push('');
  lines.push(`(${records.length} record${records.length === 1 ? '' : 's'})`);
  return lines.join('\n');
}

function renderJson(records) {
  return JSON.stringify(records || [], null, 2);
}

async function run(argv) {
  const opts = parseArgs(argv);

  if (opts.format !== 'table' && opts.format !== 'json') {
    process.stderr.write(`loopback list: --format must be table or json (got "${opts.format}")\n`);
    process.exit(2);
  }

  const url = opts.ingestUrl || process.env.LOOPBACK_INGEST_URL;
  const token = opts.token || process.env.LOOPBACK_TOKEN;
  if (!url) {
    process.stderr.write('loopback list: no ingest URL — pass --ingest-url or set LOOPBACK_INGEST_URL\n');
    process.exit(2);
  }
  if (!token) {
    process.stderr.write('loopback list: no token — pass --token or set LOOPBACK_TOKEN (must be an ADMIN token)\n');
    process.exit(2);
  }

  const query = buildQuery(opts);
  const res = await core.wire.fetchRecords({ url, token, query });

  if (!res.ok) {
    if (res.status === 401) {
      process.stderr.write('loopback list: invalid token (401)\n');
    } else if (res.status === 403) {
      process.stderr.write('loopback list: token is not admin (GET /feedback is admin-only) (403)\n');
    } else if (res.status) {
      process.stderr.write('loopback list: ' + res.error + '\n');
    } else {
      process.stderr.write('loopback list: could not reach the service — ' + res.error + '\n');
    }
    process.exit(1);
  }

  const records = Array.isArray(res.body) ? res.body : [];
  const out = opts.format === 'json' ? renderJson(records) : renderTable(records);
  process.stdout.write(out + '\n');
}

module.exports = { run, parseArgs, buildQuery, renderTable, renderJson, short };
