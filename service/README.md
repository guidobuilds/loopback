# loopback-svc

Thin central ingest service for the feedback loop. The MVP is an
**append-only feedback store**: it accepts de-identified feedback records,
re-checks redaction, and **stores every valid record** with its identifying
data. A token-guarded read-back endpoint lists all stored feedback for later
(human/automated) review. There is no registry, owner resolution,
dedup/clustering, or issue fan-out.

- **Stack:** Python + FastAPI; **SQLAlchemy 2.0** + **Alembic** over SQLite;
  per-user hashed-token bearer auth; Docker.
- **Wire contract:** `feedback-record.schema.json` (copied from the plugin; the
  single source of truth — kept in lockstep with the pydantic model by
  `tests/test_contract.py`).

## Endpoints

| Method | Path             | Notes |
|--------|------------------|-------|
| GET    | `/healthz`       | 200 liveness. |
| POST   | `/feedback`      | Ingest. Auth (any valid token) → validate → re-redact → **store**. |
| GET    | `/feedback`      | **Admin-only.** Lists stored records ("review all feedback received") with pagination + filters (below). 403 for a valid non-admin token. |

### `GET /feedback` pagination & filters

Pagination (query params; bad values → `400`):

- `limit` — max records to return. **Default `100`** when absent; `limit=0` →
  **all** records (no cap); `limit < 0` / non-integer → `400`.
- `offset` — records to skip (default `0`; `offset < 0` / non-integer → `400`).

Filters (all optional, exact match unless noted, combined with **AND**):

| param | matches | notes |
|-------|---------|-------|
| `artifact` | `artifact.id` | exact |
| `severity` | `severity` | must be `low\|medium\|high` (else `400`) |
| `confidence` | `confidence` | must be `low\|medium\|high` (else `400`) |
| `email` | submitter's user email | exact — the **user** filter (joins `users`) |
| `received_from` | server receive time `>=` | inclusive, ISO-8601 lexical |
| `received_to` | server receive time `<=` | inclusive, ISO-8601 lexical |

Records come back oldest-first (`created_at` order). Each record carries two
**server-added** fields outside the wire schema: `serverId` (the DB primary key,
`fb_srv_…`) and `submitterEmail` (the authenticated submitter, resolved from the
POSTing token). No client-supplied user identifier is carried — submitter
identity is **server-side only**.

### `POST /feedback` status contract (design §7 split — strict)

- `401` — missing/malformed/unknown bearer token.
- `400` — schema-invalid body (FastAPI/pydantic's default 422 is **normalized to
  400** here, because 422 is reserved for the case below).
- `422` — PII/secret patterns remain in `summary`/`evidenceExcerpt` → the record
  is **quarantined** (NOT written to the main `records` table).
- `200` — stored: server assigns `id`, persists, returns `{id, status: "stored"}`.

`GET /feedback` additionally returns `403` when the token is valid but **not**
an admin token.

## Config (env)

- `DB_PATH` — SQLite path (default `/tmp/loopback.db` locally, `/data/loopback.db`
  in the image).

There is **no server token env var**: auth is per-user hashed tokens stored in
the DB (see below).

## Identity & tokens (normalized `users` 1→N `tokens`)

Identity is normalized: a **`User`** is keyed by a **unique `email`** and carries
**`is_admin`**; a user has **many `Token`** rows (re-issuing for an existing email
appends a new token but reuses the same user). Every stored `Record` links to the
authenticated submitter via `records.user_id` (NOT NULL FK → `users`), set from
the POSTing token — so a record's user is **only** the authenticated person,
never a client-supplied identifier.

Auth resolves by sha256-hashing the presented `Authorization: Bearer <token>`,
looking it up in `tokens`, and joining to its `users` row for `is_admin`. There
is no shared/environment token.

- **Any valid token** may `POST /feedback`.
- **An admin token** (its user's `is_admin = 1`) is required to read
  `GET /feedback` (403 otherwise).
- Tokens are stored **hashed at rest** (sha256 hex of an `lpbk_`-prefixed,
  256-bit-entropy random token); the plaintext is shown **once** at issuance and
  is not recoverable.
- The `tokens` table is **append-only**: re-issuing for an existing email inserts
  a new row and never updates/deletes prior rows. `--admin` on an existing
  non-admin user **promotes** them (idempotent).

Mint tokens with the admin CLI `issue_token.py` (it writes directly to the DB via
the ORM, so the first admin bootstraps with no chicken-and-egg). It needs the
service venv/container deps (SQLAlchemy), so run it from the venv or in-container:

```bash
# from the service/ dir, in the venv (DB resolved via --db > $DB_PATH > /tmp/loopback.db)
.venv/bin/python issue_token.py --email you@example.com --admin   # an admin (can read)
.venv/bin/python issue_token.py --email dev@example.com           # a developer (POST only)
.venv/bin/python issue_token.py --email dev@example.com --db /path/to/loopback.db

# in docker (against the running container's DB):
docker exec -it <container> python3 issue_token.py --email dev@example.com
```

It prints the plaintext token + email + `is_admin` + created time once. Hand the
token to the developer, who sets it as `LOOPBACK_TOKEN` on their machine (the
plugin client reads that var). An invalid email exits non-zero and stores nothing.

## Storage (SQLAlchemy + Alembic)

- SQLite via **SQLAlchemy 2.0** ORM (`app/orm.py`): `users`, `tokens`, the
  append-only `records` store, and a `quarantine` table for records that fail the
  server-side redaction re-check.
- Schema is managed by **Alembic** migrations (`migrations/`). The greenfield
  baseline (`0001_initial`) creates all four tables. In production the container
  runs `alembic upgrade head` at startup; for tests/local dev the app's
  `init_db` does a fast `create_all` bootstrap off the same ORM metadata.
- Every valid record is appended verbatim and linked to its authenticated
  submitter (`records.user_id`); the client may or may not populate
  `artifact.repo`. Review the corpus via `GET /feedback`.

Apply migrations to a DB explicitly with:

```bash
# from the service/ dir, in the venv (DB resolved from $DB_PATH)
DB_PATH=/path/to/loopback.db .venv/bin/alembic upgrade head
```

## List the latest feedback

`show_latest_feedback.py` is a small **read-only** CLI (Python **stdlib only** —
no venv, no `pip install`) that prints the latest stored records newest-first.

```bash
# from the service/ dir — latest 10 from the default DB ($DB_PATH or /tmp/loopback.db)
python show_latest_feedback.py

# point at another DB / cap how many to show
DB_PATH=/path/to/loopback.db python show_latest_feedback.py
python show_latest_feedback.py --db /path/to/loopback.db --limit 25
```

It SELECTs only (never writes/alters the store), orders by `created_at` (server
receive time) DESC, and shows the server id, timestamps, artifact, work type,
severity/confidence, the submitter email (joined from `users`), summary, and
redacted evidence excerpt. Missing DB / empty store print a friendly message and
exit 0; only real read errors exit non-zero.

**Docker:** the DB lives in the `feedback-data` volume at
`/data/loopback.db`, so either run it inside the container, e.g.
`docker exec -it <container> python show_latest_feedback.py`, or copy the file
out (`docker cp <container>:/data/loopback.db ./hf.db`) and point
`DB_PATH=./hf.db` (or `--db ./hf.db`) at the copy.

## Run

```bash
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt

# apply migrations (or rely on the app's create_all bootstrap for local dev)
DB_PATH=/tmp/loopback.db .venv/bin/alembic upgrade head
.venv/bin/uvicorn app.main:app --port 8080

# mint a token to call the API (no server token env var anymore)
.venv/bin/python issue_token.py --email you@example.com --admin

# tests
.venv/bin/pytest -q

# docker (the image runs `alembic upgrade head` at startup, then uvicorn)
docker build -t loopback-svc .
docker run -d --name loopback-svc -p 8080:8080 loopback-svc
docker exec loopback-svc python3 issue_token.py --email you@example.com --admin
curl localhost:8080/healthz

# end-to-end (requires docker daemon; uses the plugin if present; mints its own tokens)
bash e2e/run-e2e.sh
```
