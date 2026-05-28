# Service reference

The loopback central service (`service/`) is a thin, **append-only feedback
store**. It accepts de-identified feedback records, re-checks redaction, and
stores every valid record with its identifying data. A token-guarded read-back
endpoint lists the stored corpus for later (human or automated) review. There is
no registry, owner resolution, dedup/clustering, or issue fan-out.

- **Stack:** Python + FastAPI; **SQLAlchemy 2.0** + **Alembic** over SQLite;
  per-user hashed-token bearer auth; Docker.
- **Port:** `8080`.
- **Wire contract:** `service/feedback-record.schema.json` (kept identical to the
  client's `loopback/core/feedback-record.schema.json`, verified by
  `service/tests/test_contract.py`).

## Run the service

### Docker Compose (recommended)

`service/docker-compose.yml` publishes `8080:8080` and mounts the named volume
`feedback-data` at `/data`. It carries **no token env var** (auth is DB-backed).

```bash
cd service
docker compose up --build -d
```

### Plain docker build / run

```bash
cd service
docker build -t loopback-svc:local .
docker run -d --name loopback-svc -v feedback-data:/data -p 8080:8080 loopback-svc:local
```

The image's `CMD` runs `alembic upgrade head` (apply migrations) and then
`uvicorn app.main:app --host 0.0.0.0 --port 8080`. `DB_PATH` defaults to
`/data/loopback.db` in the image, so mounting a volume at `/data` makes the DB
survive restarts.

### Local (no Docker)

```bash
cd service
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
DB_PATH=/tmp/loopback.db .venv/bin/alembic upgrade head   # or rely on the app's create_all bootstrap
.venv/bin/uvicorn app.main:app --port 8080
```

Locally `DB_PATH` defaults to `/tmp/loopback.db`.

## Endpoints

| Method | Path        | Auth                | Notes |
|--------|-------------|---------------------|-------|
| GET    | `/healthz`  | none                | Liveness. Returns `200` with `{"status":"ok"}`. |
| POST   | `/feedback` | any valid token     | Ingest: auth → validate → re-redact → **store**. |
| GET    | `/feedback` | **admin token only**| Lists stored records ("review all feedback received") with pagination + filters (below). |

### `POST /feedback` status contract

| Status | Meaning |
|--------|---------|
| `200` | Stored. Server assigns the id, persists, returns `{"status":"stored","id":"fb_srv_…"}`. |
| `400` | Schema-invalid body or malformed JSON. (FastAPI/pydantic's default `422` for body validation is normalized to `400` here, because `422` is reserved for the case below.) |
| `401` | Missing/malformed/unknown bearer token. |
| `422` | PII/secret patterns remain in `summary`/`evidenceExcerpt` → the record is **quarantined** (NOT written to the main `records` table). |

### `GET /feedback` status contract

| Status | Meaning |
|--------|---------|
| `200` | JSON array of stored records (oldest-first by server receive time). |
| `400` | Bad pagination (`limit < 0`, non-integer `limit`/`offset`) or an invalid `severity`/`confidence` value. |
| `401` | Missing/malformed/unknown bearer token. |
| `403` | Valid token but **not an admin** token. |

### `GET /feedback` pagination

| Param | Default | Notes |
|-------|---------|-------|
| `limit` | `100` | Max records to return. `limit=0` → **all** records (no cap). `limit < 0` / non-integer → `400`. |
| `offset` | `0` | Records to skip. `offset < 0` / non-integer → `400`. |

### `GET /feedback` filters

All optional, exact match unless noted, combined with **AND**.

| Param | Matches | Notes |
|-------|---------|-------|
| `artifact` | `artifact.id` | exact |
| `severity` | `severity` | must be `low\|medium\|high` (else `400`) |
| `confidence` | `confidence` | must be `low\|medium\|high` (else `400`) |
| `email` | submitter's user email | exact — the **user** filter (joins `users`) |
| `received_from` | server receive time `>=` | inclusive, ISO-8601 lexical |
| `received_to` | server receive time `<=` | inclusive, ISO-8601 lexical |

Each returned record carries two **server-added** fields outside the wire
schema: `serverId` (the DB primary key, `fb_srv_…`) and `submitterEmail` (the
authenticated submitter, resolved from the POSTing token). No client-supplied
user identifier is carried — submitter identity is **server-side only**.

```bash
# default page (first 100):
curl -s -H "Authorization: Bearer $ADMIN_TOKEN" localhost:8080/feedback
# all records, filtered:
curl -s -H "Authorization: Bearer $ADMIN_TOKEN" \
  "localhost:8080/feedback?artifact=prd-writer&severity=high&limit=0"
```

## Auth model (per-user, hashed tokens)

There is **no shared/environment server token**. Auth is per-user bearer tokens,
**hashed at rest** (sha256 hex of an `lpbk_`-prefixed random token). On each
request the presented `Authorization: Bearer <token>` is sha256-hashed, looked up
in the `tokens` table, and joined to its `users` row for `is_admin`.

- **Any valid token** may `POST /feedback`.
- **An admin token** (its user's `is_admin = 1`) is required to read
  `GET /feedback` (`403` otherwise).
- The plaintext is shown **once** at issuance and is not recoverable; re-issue to
  rotate (the `tokens` table is append-only).

### Minting tokens — `issue_token.py`

`service/issue_token.py` mints a per-user token and writes its hash directly to
the DB via the ORM, so the first admin bootstraps with no chicken-and-egg. It
needs the service venv/container deps (SQLAlchemy).

```bash
# developer token (POST only):
docker compose exec loopback-svc python3 issue_token.py --email dev@example.com
# admin token (can read GET /feedback):
docker compose exec loopback-svc python3 issue_token.py --email you@example.com --admin
```

| Flag | Required | Default | Effect |
|------|----------|---------|--------|
| `--email ADDR` | yes | — | The developer/operator email the token is issued to. Invalid email exits non-zero and stores nothing. |
| `--admin` | no | non-admin | Grant admin (read) access to `GET /feedback`. On an existing non-admin user, **promotes** them (idempotent). |
| `--db PATH` | no | `$DB_PATH` else `/tmp/loopback.db` | SQLite DB path; overrides `$DB_PATH`. |

Run it against the **same DB** the service uses. In Docker that means in-container
(the DB lives in the `feedback-data` volume at `/data/loopback.db`). It prints the
plaintext token + email + `is_admin` + created time once; hand the token to the
developer, who sets it as `LOOPBACK_TOKEN`.

## Persistence (SQLite, SQLAlchemy + Alembic)

The schema is managed by **Alembic** migrations (`service/migrations/`). The
container runs `alembic upgrade head` at startup; for tests/local dev the app's
`init_db` does a fast `create_all` bootstrap off the same ORM metadata
(`service/app/orm.py`). The store is **append-only**: every valid record is added
verbatim and linked to its authenticated submitter; nothing is updated or
deleted.

Four tables:

| Table | Purpose | Key fields |
|-------|---------|------------|
| `users` | A person, keyed by unique `email`; carries `is_admin`. | `id`, `email` (unique), `is_admin`, `created_at` |
| `tokens` | Per-user API tokens, hash-at-rest, append-only (re-issuing for an email appends a new row under the same user). | `id`, `user_id` → `users`, `token_hash` (unique), `created_at` |
| `records` | The append-only feedback store. `id` is the server-assigned primary key (`fb_srv_…`). | `id`, `client_id`, `schema_version`, `artifact_*`, `summary`, `work_type`, `evidence_excerpt`, `timestamp`, `severity`, `confidence`, `cluster_key`, `client_plugin`, `client_harness`, `created_at`, `user_id` → `users` (NOT NULL) |
| `quarantine` | Records that failed the server-side redaction re-check (no user link, holds the full raw JSON). | `id`, `reason`, `payload`, `created_at` |

`DB_PATH` controls the SQLite path (default `/tmp/loopback.db` locally,
`/data/loopback.db` in the image). See
[environment-variables.md](environment-variables.md).

## Troubleshooting

- **`401 unauthorized` on `POST /feedback` or `GET /feedback`** — the presented
  bearer token does not match any row in the `tokens` table (never issued, issued
  against a different DB, or mistyped). The app fails closed: unknown/missing →
  `401`. Mint a token with `issue_token.py` against the **same DB** the service
  uses, then pass it to the client (`--token …`).
- **`403 forbidden` on `GET /feedback`** — the token is valid but **not an
  admin** token. Reading the corpus requires an admin token (`issue_token.py
  --admin`); a developer token can only `POST`.
- **Stored records disappear after a restart** — the DB was not on a persisted
  volume. Run with `-v feedback-data:/data` (or compose, which mounts it).
  `docker compose down -v` / `docker volume rm feedback-data` intentionally
  deletes it. Minted tokens live in the **same** DB, so wiping the volume also
  removes all issued tokens — re-mint after a clean start.
- **Minted token does not work** — run `issue_token.py` **inside the container**
  (so it writes to the container's `DB_PATH`), copy the full `lpbk_…` value (shown
  once), and use the admin token for `GET /feedback`.

---

See also: [environment-variables.md](environment-variables.md) ·
[cli.md](cli.md) (the `loopback feedback list` read-back) · [`../DEVELOPMENT.md`](../DEVELOPMENT.md) (how to run it end to end).
