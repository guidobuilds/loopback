'use strict';
/*
 * `loopback list` — read stored feedback back from the service's admin-only
 * GET /feedback and print it as a compact aligned table (default) or pretty
 * JSON. This is the operator's "review all feedback received" path: filter +
 * paginate the corpus, or `--all --format json > feedback.json` to dump the
 * whole thing for feeding to a coding agent.
 *
 * Dependency-free by design (the CLI is intentionally stdlib-only): flag
 * parsing uses node:util parseArgs; the HTTP read lives in core/wire.js
 * (native fetch); this module just maps flags -> query, calls fetchRecords,
 * and renders.
 *
 * Auth: GET /feedback requires an ADMIN token. The token + URL are resolved via
 * core.config.resolveCredentials, which honors --token / --service-url, then
 * the LOOPBACK_TOKEN / LOOPBACK_SERVICE_URL env vars, then
 * ~/.loopback/config.json. The base service URL is combined with `/feedback`
 * via core.wire.endpoint() at call time.
 */

const { parseArgs } = require('node:util');
const core = require('../core');

// Flag schema for `loopback list`. Exported so a drift test can assert each
// declared option also appears in cli/index.js's usage() string.
const LIST_OPTIONS = {
  'format':      { type: 'string' },
  'limit':       { type: 'string' },
  'offset':      { type: 'string' },
  'artifact':    { type: 'string' },
  'severity':    { type: 'string' },
  'confidence':  { type: 'string' },
  'email':       { type: 'string' },
  'from':        { type: 'string' },
  'to':          { type: 'string' },
  'service-url': { type: 'string' },
  'token':       { type: 'string' },
  'all':         { type: 'boolean' },
};

// Parse `loopback list` argv into the options shape buildQuery / run consume.
// Maps kebab-case flag names to camelCase keys for ergonomic downstream use,
// and applies the table-as-default-format convention. strict: true makes typos
// throw an "Unknown option" error instead of being silently dropped.
function parseListArgs(argv) {
  const { values } = parseArgs({
    args: argv,
    strict: true,
    allowPositionals: false,
    options: LIST_OPTIONS,
  });
  return {
    format: values.format || 'table',
    all: values.all || false,
    limit: values.limit,
    offset: values.offset,
    artifact: values.artifact,
    severity: values.severity,
    confidence: values.confidence,
    email: values.email,
    from: values.from,
    to: values.to,
    serviceUrl: values['service-url'],
    token: values.token,
  };
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
  let opts;
  try {
    opts = parseListArgs(argv);
  } catch (err) {
    process.stderr.write('loopback list: ' + (err && err.message ? err.message : err) + '\n');
    process.exit(2);
  }

  if (opts.format !== 'table' && opts.format !== 'json') {
    process.stderr.write(`loopback list: --format must be table or json (got "${opts.format}")\n`);
    process.exit(2);
  }

  // Precedence: --flag > env var > ~/.loopback/config.json > error.
  const { serviceUrl, token } = core.config.resolveCredentials({
    flagToken: opts.token,
    flagUrl: opts.serviceUrl,
  });
  if (!serviceUrl) {
    process.stderr.write('loopback list: no service URL — pass --service-url, set LOOPBACK_SERVICE_URL, or run `loopback config --service-url URL`\n');
    process.exit(2);
  }
  if (!token) {
    process.stderr.write('loopback list: no token — pass --token, set LOOPBACK_TOKEN, or run `loopback config --token TOK` (must be an ADMIN token)\n');
    process.exit(2);
  }

  // Derive the concrete GET endpoint from the base service URL.
  const url = core.wire.endpoint(serviceUrl, '/feedback');
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

module.exports = { run, parseListArgs, LIST_OPTIONS, buildQuery, renderTable, renderJson, short };
