'use strict';
/*
 * wire (core) — the wire contract: schema validation + record assembly + POST.
 *
 * The schema (feedback-record.schema.json, co-located here) is the single source
 * of truth, mirrored by the central FastAPI service (pydantic) and checked in
 * lockstep by service/tests/test_contract.py.
 *
 * Extracted from the former servers/submit-server/index.js; assembleRecord and
 * postRecord are now parameterized (dataDir, harness, ingest url/token) instead
 * of reading Claude-Code-specific env, so they are harness-agnostic.
 */

const crypto = require('crypto');

const Ajv2020 = require('ajv/dist/2020');
const addFormats = require('ajv-formats');

const { redactMaybe } = require('./redact');
const { anonUserId } = require('./anon-id');

// require() the JSON (not fs.readFileSync) so the schema is INLINED when the MCP
// server is bundled (bun/esbuild) — a runtime fs read keyed off __dirname breaks
// once the file is bundled to a different location.
const schema = require('./feedback-record.schema.json');

const ajv = new Ajv2020({ allErrors: true, strict: false });
addFormats(ajv);
const validateRecord = ajv.compile(schema);

function newRecordId() {
  // The central DB assigns the canonical primary key; the client supplies a
  // syntactically valid placeholder so the record satisfies the schema pre-send.
  const rand = crypto.randomBytes(13).toString('hex').toUpperCase();
  return 'fb_' + rand;
}

// Build a wire record from the post-consent tool args. id/anonUserId/client/
// timestamp are stamped here, not supplied by the caller. summary + excerpt are
// defensively re-redacted (show-exactly-what-is-sent + defense in depth).
function assembleRecord(args, opts) {
  opts = opts || {};
  const version = opts.pluginVersion || '0.0.1';

  const record = {
    id: newRecordId(),
    schemaVersion: 1,
    artifact: { kind: args.artifactKind },
    summary: redactMaybe(args.summary),
    timestamp: new Date().toISOString(),
    client: { plugin: `loopback@${version}` },
  };

  if (opts.harness) record.client.harness = opts.harness;
  if (args.artifactId) record.artifact.id = args.artifactId;
  if (args.artifactVersion) record.artifact.version = args.artifactVersion;
  if (args.artifactRepo) record.artifact.repo = args.artifactRepo;
  if (args.workType) record.workType = args.workType;
  if (args.evidenceExcerpt !== undefined) record.evidenceExcerpt = redactMaybe(args.evidenceExcerpt);
  if (args.severity) record.severity = args.severity;
  if (args.confidence) record.confidence = args.confidence;
  if (args.clusterKey) record.clusterKey = args.clusterKey;

  if (opts.dataDir) {
    const uid = anonUserId(opts.dataDir);
    if (uid) record.anonUserId = uid;
  }

  return record;
}

async function postRecord(record, opts) {
  opts = opts || {};
  const url = opts.url;
  const token = opts.token;
  if (!url) return { ok: false, error: 'LOOPBACK_INGEST_URL is not configured' };

  const headers = { 'content-type': 'application/json' };
  if (token) headers['authorization'] = 'Bearer ' + token;

  try {
    const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(record) });
    const text = await res.text();
    let body;
    try {
      body = JSON.parse(text);
    } catch (_) {
      body = { raw: text };
    }
    if (!res.ok) {
      return { ok: false, error: `ingest responded ${res.status}: ${text.slice(0, 300)}` };
    }
    return { ok: true, body };
  } catch (err) {
    return { ok: false, error: 'POST failed: ' + err.message };
  }
}

module.exports = { schema, validateRecord, assembleRecord, postRecord, newRecordId };
