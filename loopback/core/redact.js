'use strict';
/*
 * redact (core) — client-side redaction (design §7).
 *
 * Strips PII / secrets from a candidate excerpt BEFORE it is shown in the consent
 * gate and BEFORE it leaves the machine. The output is exactly what the consent
 * gate displays and exactly what is sent (show-exactly-what-is-sent).
 *
 * Extracted verbatim from the former scripts/redact so the behavior (and the
 * fixtures/redact-cases.json contract) is unchanged; now an in-process pure
 * function reused by the MCP server, the CLI, and the submit path.
 *
 * Idempotent: re-running on already-redacted text is a no-op. The [redacted-*]
 * placeholders never re-match any pattern.
 */

const MAX_LEN = 600; // excerpt cap in BYTES (matches the consent-gate budget)

function byteLen(str) {
  return Buffer.byteLength(str, 'utf8');
}

// Slice to at most `maxBytes` bytes without splitting a multi-byte UTF-8 char.
function sliceBytes(str, maxBytes) {
  const buf = Buffer.from(str, 'utf8');
  if (buf.length <= maxBytes) return str;
  let end = maxBytes;
  while (end > 0 && (buf[end] & 0xc0) === 0x80) end--;
  return buf.slice(0, end).toString('utf8');
}

// Order matters: emails and tokens first (most specific), then paths, then files,
// then user/home tokens. Each replacement target is placeholder-safe.
function redactText(input) {
  let s = String(input);

  // 1. Emails.
  s = s.replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[redacted-email]');

  // 2. Known secret/token shapes.
  s = s.replace(/\bgh[pousr]_[A-Za-z0-9]{16,}\b/g, '[redacted-token]');
  s = s.replace(/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, '[redacted-token]');
  s = s.replace(/\bAKIA[0-9A-Z]{12,}\b/g, '[redacted-token]');
  s = s.replace(/\bsk-[A-Za-z0-9_-]{16,}\b/g, '[redacted-token]');
  s = s.replace(/\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, '[redacted-token]');
  s = s.replace(/\bey[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{6,}\b/g, '[redacted-token]');
  s = s.replace(/\b[Bb]earer\s+[A-Za-z0-9._-]{8,}/g, 'Bearer [redacted-token]');
  s = s.replace(/\b[A-Fa-f0-9]{32,}\b/g, '[redacted-token]');
  s = s.replace(/\b[A-Za-z0-9+/]{40,}={0,2}\b/g, '[redacted-token]');

  // 3. Filesystem paths — only genuinely path-like tokens, never ordinary
  //    `/`-delimited prose (e.g. "Problem/Solution/Metrics", "TCP/IP").
  const PATH_TAIL = "[^\\s\"'`<>|]*[^\\s\"'`<>|.,;:!?)]";
  const BOUND = "(?:^|(?<=[\\s\"'`(<\\[{]))"; // start-of-token boundary (lookbehind)
  s = s.replace(
    /\b[\w.~-]+(?:\/[\w.~-]+)+\.(?:ts|tsx|js|jsx|mjs|cjs|py|rb|go|rs|java|kt|c|cc|cpp|h|hpp|cs|php|swift|md|json|yaml|yml|toml|ini|env|txt|sql|sh|html|css|scss)\b/gi,
    '[redacted-path]'
  );
  s = s.replace(
    new RegExp('\\S*\\/(?:Users|home|var|tmp|etc|opt|private)\\/' + PATH_TAIL, 'g'),
    '[redacted-path]'
  );
  s = s.replace(
    new RegExp(BOUND + '(?:[A-Za-z]:\\\\|\\\\\\\\|~\\/|\\.{1,2}\\/|\\/)' + PATH_TAIL, 'g'),
    '[redacted-path]'
  );

  // 4. Bare relative file names with a code/doc extension (e.g. auth.ts, prd.md).
  s = s.replace(
    /\b[\w-]+\.(?:ts|tsx|js|jsx|mjs|cjs|py|rb|go|rs|java|kt|c|cc|cpp|h|hpp|cs|php|swift|md|json|yaml|yml|toml|ini|env|txt|sql|sh|html|css|scss)\b/gi,
    '[redacted-file]'
  );

  // 5. Usernames / home references.
  s = s.replace(/\$HOME\b/g, '[redacted-user]');
  s = s.replace(/\bhome directory of [\w.-]+/gi, 'home directory of [redacted-user]');
  if (process.env.USER) {
    const u = process.env.USER.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (u) s = s.replace(new RegExp('\\b' + u + '\\b', 'g'), '[redacted-user]');
  }
  // Collapse repeated placeholders that landed adjacent.
  s = s.replace(/(\[redacted-path\])(\[redacted-(?:file|user)\])+/g, '$1');

  // 6. Cap length last, on a clean boundary so we never split a placeholder.
  if (byteLen(s) > MAX_LEN) {
    const SUFFIX = ' …';
    const budget = MAX_LEN - byteLen(SUFFIX);
    s = sliceBytes(s, budget);
    const lastOpen = s.lastIndexOf('[redacted');
    const lastClose = s.lastIndexOf(']');
    if (lastOpen > lastClose) s = s.slice(0, lastOpen);
    s = s.replace(/\s+$/, '') + SUFFIX;
  }

  return s;
}

// Same as redactText but preserves undefined/null/'' inputs (the submit path
// must not turn an absent optional field into the string "undefined").
function redactMaybe(text) {
  if (text === undefined || text === null || text === '') return text;
  return redactText(text);
}

module.exports = { redactText, redactMaybe, MAX_LEN };
