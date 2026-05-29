'use strict';
/* Local service E2E (no Docker, no nested model): drives the loopback MCP server's
 * submit_feedback against a real running FastAPI service, then reads it back as
 * admin and asserts client.harness round-tripped through SQLite and the stored
 * excerpt was redacted server-side. Orchestrated by test/e2e-local.sh. */

const path = require('path');
const assert = require('assert');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');
const core = require('../core');

(async () => {
  // The service URL is the BASE (no `/feedback`); endpoint paths are derived
  // here for the admin read-back.
  const BASE = process.env.LOOPBACK_SERVICE_URL || '';
  const READ = process.env.READ_URL || (BASE ? BASE.replace(/\/+$/, '') + '/feedback' : '');
  const ADMIN = process.env.ADMIN_TOKEN;
  assert(BASE && ADMIN, 'need LOOPBACK_SERVICE_URL + ADMIN_TOKEN');

  // The MCP server reads its credentials from process.env / ~/.loopback/config.json.
  const childEnv = Object.assign({}, process.env, {
    LOOPBACK_HARNESS: 'claude-code',
    LOOPBACK_SERVICE_URL: BASE,
  });
  const transport = new StdioClientTransport({
    command: 'node',
    args: [path.join(__dirname, '..', 'mcp', 'index.js')],
    // Simulate the Claude Code adapter's .mcp.json env (literal harness value).
    env: childEnv,
  });
  const client = new Client({ name: 'e2e', version: '0' });
  await client.connect(transport);

  const res = await client.callTool({
    name: 'submit_feedback',
    arguments: {
      artifactKind: 'skill',
      artifactId: 'prd-writer',
      artifactVersion: '3.2.0',
      summary: 'PRDs should use the Problem/Solution/Metrics template, not freeform.',
      workType: 'prd-authoring',
      severity: 'medium',
      confidence: 'high',
      clusterKey: 'prd-writer:prd-authoring:wrong-template',
      evidenceExcerpt: 'freeform used in /Users/x/prd.md by jane@example.com',
    },
  });
  const out = JSON.parse(res.content[0].text);
  console.log('submit:', JSON.stringify(out));
  assert.strictEqual(out.status, 'ok', 'submit should succeed');
  assert.ok(String(out.id).startsWith('fb_'), 'server-assigned id');
  await client.close();

  const r = await fetch(READ, { headers: { authorization: 'Bearer ' + ADMIN } });
  assert.strictEqual(r.status, 200, 'admin GET /feedback should be 200');
  const recs = await r.json();
  assert.ok(recs.length >= 1, 'at least one record stored');
  const rec = recs[recs.length - 1];
  console.log('stored client:', JSON.stringify(rec.client), 'excerpt:', JSON.stringify(rec.evidenceExcerpt));

  assert.strictEqual(rec.client.harness, 'claude-code', 'client.harness round-trips through SQLite');
  assert.strictEqual(rec.client.plugin, `loopback@${require('../package.json').version}`, 'client.plugin round-trips');
  assert.ok(
    !/jane@example\.com/.test(rec.evidenceExcerpt) && !/\/Users\//.test(rec.evidenceExcerpt),
    'server stored a redacted excerpt: ' + rec.evidenceExcerpt
  );

  // `id` (server-assigned) and `submitterEmail` live outside the ingest wire
  // contract; pop both before re-validating the stored record against the schema.
  const copy = Object.assign({}, rec);
  delete copy.id;
  delete copy.submitterEmail;
  assert.ok(core.wire.validateRecord(copy), 'stored record schema-valid: ' + JSON.stringify(core.wire.validateRecord.errors));

  console.log('\nLOCAL SERVICE E2E OK — MCP -> FastAPI -> SQLite -> admin read-back; harness round-trips, excerpt redacted.');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
