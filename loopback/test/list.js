'use strict';
/* Unit + integration checks for the `loopback list` read path:
 *   - cli/list.js flag parsing -> query mapping + table renderer
 *   - core/wire.js fetchRecords against a throwaway HTTP server (mirrors the
 *     server pattern in test/mcp-smoke.js): asserts the GET path + query string
 *     and the Authorization: Bearer header, and that json/table output render.
 * Invoked from test/run.js. Stdlib `assert` only. */

const http = require('http');
const assert = require('assert');

const core = require('../core');
const list = require('../cli/list');

function section(name, fn) {
  return Promise.resolve(fn()).then(() => console.log('  ✓ ' + name));
}

const SAMPLE = [
  {
    id: 'fb_a',
    serverId: 'fb_srv_a',
    submitterEmail: 'alice@example.com',
    schemaVersion: 1,
    artifact: { kind: 'skill', id: 'prd-writer' },
    summary: 'PRDs should use the Problem/Solution/Metrics template.',
    severity: 'high',
    confidence: 'medium',
    timestamp: '2026-05-22T17:40:00Z',
  },
];

async function run() {
  console.log('\nloopback list checks:');

  await section('parseArgs reads format/flags and --all', () => {
    const o = list.parseListArgs(['--format', 'json', '--all', '--artifact', 'prd-writer', '--severity', 'high']);
    assert.strictEqual(o.format, 'json');
    assert.strictEqual(o.all, true);
    assert.strictEqual(o.artifact, 'prd-writer');
    assert.strictEqual(o.severity, 'high');
    // default format is table when --format is absent
    assert.strictEqual(list.parseListArgs([]).format, 'table');
  });

  await section('buildQuery maps flags -> query; --all => limit=0', () => {
    const q = list.buildQuery(list.parseListArgs([
      '--all', '--offset', '5', '--artifact', 'prd-writer',
      '--severity', 'high', '--confidence', 'low', '--email', 'a@b.co',
      '--from', '2026-05-01T00:00:00Z', '--to', '2026-05-31T00:00:00Z',
    ]));
    assert.deepStrictEqual(q, {
      limit: 0,
      offset: '5',
      artifact: 'prd-writer',
      severity: 'high',
      confidence: 'low',
      email: 'a@b.co',
      received_from: '2026-05-01T00:00:00Z',
      received_to: '2026-05-31T00:00:00Z',
    });
    // --all wins over --limit; unset flags are omitted entirely.
    const q2 = list.buildQuery(list.parseListArgs(['--limit', '7']));
    assert.deepStrictEqual(q2, { limit: '7' });
    assert.deepStrictEqual(list.buildQuery(list.parseListArgs(['--all', '--limit', '7'])), { limit: 0 });
  });

  await section('table renderer aligns columns + footer count; json pretty-prints', () => {
    const table = list.renderTable(SAMPLE);
    assert.ok(table.includes('RECEIVED'), 'header present');
    assert.ok(table.includes('SUMMARY'), 'header present');
    assert.ok(table.includes('prd-writer'), 'artifact id rendered');
    assert.ok(table.includes('alice@example.com'), 'submitter email rendered');
    assert.ok(table.includes('high'), 'severity rendered');
    assert.ok(/\(1 record\)/.test(table), 'footer count present');
    assert.strictEqual(list.renderTable([]), 'no records');

    const json = list.renderJson(SAMPLE);
    assert.deepStrictEqual(JSON.parse(json), SAMPLE);
    assert.ok(json.includes('\n  '), 'json is pretty-printed (indented)');
  });

  await section('short() truncates with ascii ellipsis; collapses whitespace', () => {
    assert.strictEqual(list.short('-', 5), '-');
    assert.strictEqual(list.short(undefined, 5), '-');
    assert.strictEqual(list.short('abcdefghij', 8), 'abcde...');
    assert.strictEqual(list.short('a   b', 10), 'a b');
  });

  await section('fetchRecords GETs path+query with Bearer header (throwaway server)', async () => {
    let seenUrl = null;
    let seenAuth = null;
    let seenMethod = null;
    const srv = http.createServer((req, res) => {
      seenUrl = req.url;
      seenAuth = req.headers['authorization'];
      seenMethod = req.method;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(SAMPLE));
    });
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    const port = srv.address().port;
    try {
      const res = await core.wire.fetchRecords({
        url: `http://127.0.0.1:${port}/feedback`,
        token: 'admintok',
        query: { limit: 0, severity: 'high', email: '', artifact: 'prd-writer' },
      });
      assert.strictEqual(res.ok, true, JSON.stringify(res));
      assert.deepStrictEqual(res.body, SAMPLE);
      assert.strictEqual(seenMethod, 'GET');
      assert.strictEqual(seenAuth, 'Bearer admintok');
      // path is /feedback; query carries set values, drops empty ones (email='').
      assert.ok(seenUrl.startsWith('/feedback?'), 'path is /feedback with query: ' + seenUrl);
      assert.ok(seenUrl.includes('limit=0'), seenUrl);
      assert.ok(seenUrl.includes('severity=high'), seenUrl);
      assert.ok(seenUrl.includes('artifact=prd-writer'), seenUrl);
      assert.ok(!seenUrl.includes('email='), 'empty email omitted: ' + seenUrl);
    } finally {
      srv.close();
    }
  });

  await section('fetchRecords surfaces non-2xx status (401/403) in error + status', async () => {
    const srv = http.createServer((req, res) => {
      res.writeHead(403, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ detail: 'forbidden' }));
    });
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    const port = srv.address().port;
    try {
      const res = await core.wire.fetchRecords({ url: `http://127.0.0.1:${port}/feedback`, token: 'x' });
      assert.strictEqual(res.ok, false);
      assert.strictEqual(res.status, 403);
      assert.ok(/403/.test(res.error), res.error);
    } finally {
      srv.close();
    }
  });
}

module.exports = { run };
