'use strict';
/*
 * `loopback feedback list` — read stored feedback back from the service's
 * admin-only GET /feedback and print it as a compact aligned table (default)
 * or pretty JSON.
 *
 * Credentials come from ~/.loopback/config.json (via core.config) — this
 * command does NOT accept --service-url / --token flags. Run `loopback auth
 * --service-url … --token …` first; rotate with `loopback auth --token …`.
 * Authorization (admin vs user, revoked tokens) is enforced server-side; we
 * surface 401/403 with friendly messages instead of raw JSON.
 *
 * Dependency-free by design: stdlib parseArgs + native fetch (in core/wire).
 */

const { parseArgs } = require('node:util');
const core = require('../core');

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
  'all':         { type: 'boolean' },
};

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
  };
}

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

async function runList(argv) {
  let opts;
  try {
    opts = parseListArgs(argv);
  } catch (err) {
    process.stderr.write('loopback feedback list: ' + (err && err.message ? err.message : err) + '\n');
    process.exit(2);
  }

  if (opts.format !== 'table' && opts.format !== 'json') {
    process.stderr.write(`loopback feedback list: --format must be table or json (got "${opts.format}")\n`);
    process.exit(2);
  }

  const { serviceUrl, token } = core.config.resolveCredentials({});
  if (!serviceUrl || !token) {
    process.stderr.write(
      'loopback feedback list: no credentials configured — run `loopback auth --service-url URL --token TOK` first ' +
      '(GET /feedback requires an ADMIN token)\n'
    );
    process.exit(1);
  }

  const url = core.wire.endpoint(serviceUrl, '/feedback');
  const query = buildQuery(opts);
  const res = await core.wire.fetchRecords({ url, token, query });

  if (!res.ok) {
    if (res.status === 401) {
      process.stderr.write(
        'loopback feedback list: authentication failed — token may be invalid or revoked. ' +
        'Re-run `loopback auth --token …`.\n'
      );
    } else if (res.status === 403) {
      process.stderr.write(
        'loopback feedback list: permission denied — `feedback list` requires an admin token. ' +
        'Your current token is user-scope.\n'
      );
    } else if (res.status) {
      process.stderr.write('loopback feedback list: ' + res.error + '\n');
    } else {
      process.stderr.write(
        `loopback feedback list: cannot reach the service at ${serviceUrl} — ` +
        (res.error || 'network error') + '. Check the URL or re-run `loopback auth --service-url …`.\n'
      );
    }
    process.exit(1);
  }

  const records = Array.isArray(res.body) ? res.body : [];
  const out = opts.format === 'json' ? renderJson(records) : renderTable(records);
  process.stdout.write(out + '\n');
}

module.exports = { runList, parseListArgs, LIST_OPTIONS, buildQuery, renderTable, renderJson, short };
