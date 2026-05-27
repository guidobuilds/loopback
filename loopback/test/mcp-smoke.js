'use strict';
/* End-to-end smoke test for the loopback MCP server: spawns it over stdio,
 * lists tools, exercises each, and verifies submit_feedback POSTs a redacted,
 * harness-stamped record to a throwaway local endpoint. */

const http = require('http');
const path = require('path');
const assert = require('assert');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');

function textOf(r) {
  return JSON.parse(r.content[0].text);
}

(async () => {
  let received = null;
  const srv = http.createServer((req, res) => {
    let b = '';
    req.on('data', (c) => (b += c));
    req.on('end', () => {
      received = JSON.parse(b || '{}');
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status: 'stored', id: 'fb_srv_test', issueUrl: 'http://issue/1' }));
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;

  // Default to the source entry; LOOPBACK_MCP_ENTRY lets the verifier point at the
  // bundled, self-contained server (to prove it runs with no node_modules).
  const entry = process.env.LOOPBACK_MCP_ENTRY || path.join(__dirname, '..', 'mcp', 'index.js');
  const transport = new StdioClientTransport({
    command: 'node',
    args: [entry],
    env: Object.assign({}, process.env, {
      // Persisted shape is the BASE URL (no `/feedback`); the MCP server's
      // submit_feedback handler derives the endpoint via core.wire.endpoint().
      LOOPBACK_SERVICE_URL: `http://127.0.0.1:${port}`,
      LOOPBACK_TOKEN: 'tok',
      LOOPBACK_HARNESS: 'codex',
    }),
  });
  const client = new Client({ name: 'smoke', version: '0' });
  await client.connect(transport);

  const tools = (await client.listTools()).tools.map((t) => t.name).sort();
  console.log('tools:', tools.join(', '));
  assert.deepStrictEqual(tools, [
    'get_session_state',
    'is_muted',
    'mute_artifact',
    'record_signal',
    'redact_preview',
    'submit_feedback',
  ]);

  const rp = textOf(await client.callTool({ name: 'redact_preview', arguments: { text: 'see jane@example.com' } }));
  console.log('redact_preview:', JSON.stringify(rp));
  assert.strictEqual(rp.changed, true);
  assert.ok(rp.redacted.includes('[redacted-email]'));

  assert.strictEqual(textOf(await client.callTool({ name: 'is_muted', arguments: { artifactId: 'foo' } })).muted, false);
  await client.callTool({ name: 'mute_artifact', arguments: { artifactId: 'foo' } });
  assert.strictEqual(textOf(await client.callTool({ name: 'is_muted', arguments: { artifactId: 'foo' } })).muted, true);
  console.log('mute round-trip via MCP: OK');

  await client.callTool({ name: 'record_signal', arguments: { type: 'correction', artifactId: 'prd-writer' } });
  const gs = textOf(await client.callTool({ name: 'get_session_state', arguments: {} }));
  console.log('get_session_state:', JSON.stringify(gs));
  assert.strictEqual(gs.correctionCount, 1);
  assert.ok(gs.muted.includes('foo'));

  const sf = textOf(
    await client.callTool({
      name: 'submit_feedback',
      arguments: {
        artifactKind: 'skill',
        artifactId: 'prd-writer',
        summary: 'PRDs should use Problem/Solution/Metrics, not freeform.',
        evidenceExcerpt: 'used freeform at /Users/x/prd.md',
        severity: 'medium',
        confidence: 'high',
      },
    })
  );
  console.log('submit_feedback:', JSON.stringify(sf));
  assert.strictEqual(sf.status, 'ok');
  assert.strictEqual(sf.id, 'fb_srv_test');
  assert.strictEqual(received.client.harness, 'codex');
  assert.strictEqual(received.client.plugin, 'loopback@0.0.1');
  assert.ok(!/\/Users\//.test(received.evidenceExcerpt), 'excerpt must be redacted server-side: ' + received.evidenceExcerpt);
  assert.ok(!('anonUserId' in received), 'anonUserId must not be on the wire (identity is server-side)');
  console.log('server received client:', JSON.stringify(received.client), 'excerpt:', JSON.stringify(received.evidenceExcerpt));

  // debounce flag set after submit
  const gs2 = textOf(await client.callTool({ name: 'get_session_state', arguments: {} }));
  assert.ok(gs2.raised.includes('prd-writer'), 'submit should mark artifact raised');

  await client.close();
  srv.close();
  console.log('\nMCP SMOKE OK');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
