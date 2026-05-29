#!/usr/bin/env node
/*
 * loopback MCP server — the universal interface (works identically under Claude
 * Code, OpenCode, and Codex). The detector skill / slash command drive the whole
 * flow by calling these tools, so the SAME portable SKILL.md needs no
 * harness-specific shell-outs.
 *
 * Tools (all GENERAL):
 *   submit_feedback   — terminal POST after the user chose [S]end (re-redacts,
 *                       validates against the wire contract, stamps
 *                       client.{plugin,harness}, POSTs to the ingest service).
 *   redact_preview    — redact an excerpt and report whether anything was removed
 *                       (lets the consent gate show exactly-what-is-sent).
 *   is_muted          — is this artifact muted on this machine?
 *   mute_artifact     — mute an artifact ([N]ever for this skill).
 *   get_session_state — primed signals + debounce state + mutes for this session.
 *   record_signal     — record a Tier-1 signal (for harnesses without hook context).
 *
 * Nothing here makes a defect-vs-iteration judgment: that is the skill's job. The
 * server only validates, redacts, transmits, and tracks state the user approved.
 */
'use strict';

const z = require('zod');
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');

const core = require('../core');

const DATA_DIR = core.resolveDataDir();
const HARNESS = core.resolveHarness();
const PLUGIN_VERSION = readVersion();

function readVersion() {
  try {
    return require('../package.json').version || '0.0.1';
  } catch (_) {
    return '0.0.1';
  }
}

function ok(obj) {
  return { content: [{ type: 'text', text: JSON.stringify(obj) }] };
}
function err(error, extra) {
  return {
    isError: true,
    content: [{ type: 'text', text: JSON.stringify(Object.assign({ status: 'error', error }, extra || {})) }],
  };
}

const server = new McpServer({ name: 'loopback', version: PLUGIN_VERSION });

/* ---- submit_feedback ---------------------------------------------------- */
server.registerTool(
  'submit_feedback',
  {
    title: 'Submit loopback feedback',
    description:
      'Submit ONE de-identified loopback record to the central feedback service. ' +
      'Call this ONLY after the user explicitly chose [S]end at the consent gate. The ' +
      'server re-redacts summary/excerpt, validates against the shared wire contract, ' +
      'stamps client.{plugin,harness}, and POSTs to the configured service URL.',
    inputSchema: {
      artifactKind: z.enum(['skill', 'agent', 'artifact']).describe('Kind of artifact the feedback is about.'),
      artifactId: z.string().min(1).describe("Artifact id, e.g. 'prd-writer'."),
      artifactVersion: z.string().min(1).optional().describe("Artifact version, e.g. '3.2.0'."),
      artifactRepo: z.string().min(1).optional().describe('Optional repo where the user was working (e.g. from `git remote get-url origin`).'),
      summary: z.string().min(1).describe('The synthesized, de-identified, generalizable lesson (= summary).'),
      workType: z.string().min(1).optional().describe("Task category, e.g. 'prd-authoring'."),
      evidenceExcerpt: z.string().optional().describe('Minimal, already-redacted excerpt the user approved.'),
      severity: z.enum(['low', 'medium', 'high']).optional().describe('Defect severity.'),
      confidence: z.enum(['low', 'medium', 'high']).optional().describe('Detector self-rating.'),
      clusterKey: z.string().min(1).optional().describe('Proposed dedup key, e.g. artifact:workType:problem.'),
    },
  },
  async (args) => {
    const record = core.wire.assembleRecord(args, {
      harness: HARNESS,
      pluginVersion: PLUGIN_VERSION,
    });

    if (!core.wire.validateRecord(record)) {
      const details = (core.wire.validateRecord.errors || []).map((e) => `${e.instancePath || '/'} ${e.message}`);
      return err('record failed schema validation', { details });
    }

    // Credentials precedence: env var > ~/.loopback/config.json (written by
    // `loopback auth`). The MCP server has no flags, so there's no flag layer
    // here. The persisted base URL is combined with the `/feedback` path via
    // core.wire.endpoint() — a missing base short-circuits to a null URL which
    // postRecord rejects with a clear error.
    const { serviceUrl, token } = core.config.resolveCredentials({});
    const url = serviceUrl ? core.wire.endpoint(serviceUrl, '/feedback') : null;
    const result = await core.wire.postRecord(record, {
      url,
      token,
    });
    if (!result.ok) return err(result.error);

    // Debounce: do not raise another candidate for this artifact this session.
    core.sessionState.markRaised(args.artifactId);

    const issueUrl = result.body && (result.body.issueUrl || result.body.issue_url);
    return ok({ status: 'ok', issueUrl: issueUrl || null, id: result.body && result.body.id });
  }
);

/* ---- redact_preview ----------------------------------------------------- */
server.registerTool(
  'redact_preview',
  {
    title: 'Preview redaction',
    description:
      'Redact a candidate excerpt the SAME way submit_feedback will, and report ' +
      'whether anything was removed. Use this to render the consent gate so the ' +
      'evidence shown is byte-for-byte what gets sent (show-exactly-what-is-sent).',
    inputSchema: {
      text: z.string().describe('The raw excerpt to redact before showing/sending.'),
    },
  },
  async ({ text }) => {
    const redacted = core.redactText(text);
    return ok({ redacted, changed: redacted !== String(text), length: redacted.length });
  }
);

/* ---- is_muted ----------------------------------------------------------- */
server.registerTool(
  'is_muted',
  {
    title: 'Check mute',
    description: 'Return whether the given artifact is muted on this machine ([N]ever was chosen earlier).',
    inputSchema: { artifactId: z.string().min(1).describe('Artifact id to check.') },
  },
  async ({ artifactId }) => ok({ artifactId, muted: core.mutes.isMuted(DATA_DIR, artifactId) })
);

/* ---- mute_artifact ------------------------------------------------------ */
server.registerTool(
  'mute_artifact',
  {
    title: 'Mute artifact',
    description:
      'Mute an artifact on this machine so the detector stops raising candidates for it ' +
      '(backs the [N]ever for this skill consent-gate action). Idempotent.',
    inputSchema: { artifactId: z.string().min(1).describe('Artifact id to mute.') },
  },
  async ({ artifactId }) => {
    core.mutes.mute(DATA_DIR, artifactId);
    return ok({ status: 'ok', artifactId, muted: true });
  }
);

/* ---- get_session_state -------------------------------------------------- */
server.registerTool(
  'get_session_state',
  {
    title: 'Get session state',
    description:
      'Return the in-session debounce state (signals recorded this session, artifacts ' +
      'for which a candidate was already raised) plus the local mute list. Use this to ' +
      'enforce "one candidate per artifact per session" and to respect mutes.',
    inputSchema: {},
  },
  async () => {
    const s = core.sessionState.getState();
    return ok(Object.assign({}, s, { muted: core.mutes.listMutes(DATA_DIR) }));
  }
);

/* ---- record_signal ------------------------------------------------------ */
server.registerTool(
  'record_signal',
  {
    title: 'Record signal',
    description:
      'Record a Tier-1 signal observed this session (correction language, same-file ' +
      'revert, or repeated re-instruction). Useful on harnesses that do not inject ' +
      'hook context. Does NOT decide a defect or send anything.',
    inputSchema: {
      type: z.enum(['correction', 'revert', 'reinstruct']).describe('The kind of Tier-1 signal.'),
      artifactId: z.string().min(1).optional().describe('Artifact the signal relates to, if known.'),
      note: z.string().optional().describe('Short free-text note for context.'),
    },
  },
  async ({ type, artifactId, note }) => {
    const entry = core.sessionState.recordSignal({ type, artifactId, note });
    return ok({ status: 'ok', recorded: entry, state: core.sessionState.getState() });
  }
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((e) => {
  process.stderr.write('loopback-mcp fatal: ' + (e && e.stack ? e.stack : e) + '\n');
  process.exit(1);
});
