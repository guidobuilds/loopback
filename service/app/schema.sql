-- Loopback central service schema (MVP: append-only store).
-- De-identified by construction: only the summary (synthesized lesson) and a
-- redacted evidence excerpt are persisted; no raw artifact/output content.

-- (a) Persisted feedback rows. `id` is the SERVER-assigned primary key. This is
-- the append-only feedback store: every valid record lands here for later
-- (human/automated) review via GET /feedback.
CREATE TABLE IF NOT EXISTS records (
    id               TEXT PRIMARY KEY,            -- server-assigned record id
    client_id        TEXT,                        -- id the client sent (design §5)
    schema_version   INTEGER NOT NULL,
    artifact_kind    TEXT NOT NULL,               -- skill | agent | artifact
    artifact_id      TEXT,
    artifact_version TEXT,
    artifact_repo    TEXT,
    summary          TEXT NOT NULL,               -- de-identified synthesized lesson
    work_type        TEXT,
    evidence_excerpt TEXT,                         -- minimal, redacted
    timestamp        TEXT,
    anon_user_id     TEXT,
    severity         TEXT,
    confidence       TEXT,
    cluster_key      TEXT,
    client_plugin    TEXT,
    client_harness   TEXT,                          -- claude-code | opencode | codex (telemetry)
    created_at       TEXT NOT NULL                 -- server receive time (ISO 8601)
);

-- (b) Quarantine for records that fail server-side redaction re-check (design §7).
-- These are NOT placed in the main `records` table.
CREATE TABLE IF NOT EXISTS quarantine (
    id            TEXT PRIMARY KEY,
    reason        TEXT NOT NULL,
    payload       TEXT NOT NULL,                  -- full raw JSON of the offending record
    created_at    TEXT NOT NULL
);

-- (c) Per-user issued API tokens. Append-only / immutable: issuing a token for
-- an existing email inserts a NEW row; prior rows are NEVER updated or deleted.
-- Only a one-way sha256 hash of the token is stored; the plaintext is shown to
-- the admin ONCE at creation and is not recoverable. `is_admin = 1` grants the
-- token read access to GET /feedback; any valid token may POST /feedback.
CREATE TABLE IF NOT EXISTS tokens (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    email       TEXT NOT NULL CHECK (length(trim(email)) > 0),
    token_hash  TEXT NOT NULL CHECK (length(trim(token_hash)) > 0),
    is_admin    INTEGER NOT NULL DEFAULT 0,
    created_at  TEXT NOT NULL                     -- ISO 8601 issue time
);

-- Auth looks up by hash; uniqueness also defends against the (astronomically
-- unlikely) hash collision and makes the lookup index-backed.
CREATE UNIQUE INDEX IF NOT EXISTS idx_tokens_token_hash ON tokens (token_hash);
-- Fast "tokens for this email" listing/audit.
CREATE INDEX IF NOT EXISTS idx_tokens_email ON tokens (email);
