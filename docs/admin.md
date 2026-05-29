# Admin workflow

This guide is for **admins / harness owners** — the people running the central
loopback service and reading the feedback corpus back. For developer
installation see [install.md](install.md); for the service's contract see
[service.md](service.md).

There is **no CLI** for reading feedback back. The service exposes a
token-guarded `GET /feedback` endpoint; `curl` (or any HTTP client) is the
intended interface.

## 1. Run the service

The recommended path is Docker Compose. Service code lives in
[`service/`](../service/); see [service.md](service.md) for the full reference.

```bash
cd service
docker compose up --build -d                # listens on :8080, mounts a named volume for the DB
```

For local-only development (no Docker):

```bash
cd service
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
DB_PATH=/tmp/loopback.db .venv/bin/alembic upgrade head
.venv/bin/uvicorn app.main:app --port 8080
```

Confirm it's up:

```bash
curl -s http://localhost:8080/healthz       # → {"status":"ok"}
```

## 2. Mint tokens

There is **no shared server token**. Auth is per-user bearer tokens, hashed at
rest. The first admin bootstraps itself by writing to the DB directly via
`service/issue_token.py`:

```bash
# Admin token (can read GET /feedback):
docker compose exec loopback-svc python3 issue_token.py \
  --email you@example.com --admin

# Developer token (POST /feedback only):
docker compose exec loopback-svc python3 issue_token.py \
  --email dev@example.com
```

`issue_token.py` flags:

| Flag | Required | Default | Effect |
|------|----------|---------|--------|
| `--email <addr>` | yes | — | Email the token is issued to. Invalid email exits non-zero, stores nothing. |
| `--admin` | no | non-admin | Grant admin (read) access to `GET /feedback`. Promotes an existing non-admin user to admin (idempotent). |
| `--db <path>` | no | `$DB_PATH` else `/tmp/loopback.db` | SQLite DB path; overrides `$DB_PATH`. |

The plaintext token is shown **once** at issuance and is not recoverable;
re-issue to rotate (the `tokens` table is append-only). Run `issue_token.py`
against the **same DB** the service uses (inside the container if you're using
Compose, so it writes to `/data/loopback.db` in the volume).

Hand the developer token to the developer; they pass it to the installer:

```bash
npx @guidobuilds/loopback-setup claude-code --service-url http://localhost:8080 --token <token>
```

## 3. Query feedback via `curl`

`GET /feedback` requires an **admin token** (`403` otherwise). Set the token
+ base URL in environment variables and reuse them:

```bash
export ADMIN_TOKEN='lpbk_…'           # the value issue_token.py printed
export URL='http://localhost:8080'
```

### Default page (first 100 records)

```bash
curl -H "Authorization: Bearer $ADMIN_TOKEN" "$URL/feedback"
```

Returns a JSON array of records, oldest-first by server receive time. Default
page size is 100.

### All records (no pagination cap)

```bash
curl -H "Authorization: Bearer $ADMIN_TOKEN" "$URL/feedback?limit=0"
```

`limit=0` is the explicit "all records" sentinel. `limit < 0` or non-integer
returns `400`.

### Pagination

```bash
# Page 2 (records 51 through 100), 50 per page:
curl -H "Authorization: Bearer $ADMIN_TOKEN" "$URL/feedback?limit=50&offset=50"
```

### Filter by severity

```bash
curl -H "Authorization: Bearer $ADMIN_TOKEN" "$URL/feedback?severity=high"
```

`severity` must be `low | medium | high` (else `400`). Same for `confidence`.

### Combine filters (AND)

```bash
curl -H "Authorization: Bearer $ADMIN_TOKEN" \
  "$URL/feedback?severity=high&confidence=high&limit=10"
```

### Filter by artifact

```bash
curl -H "Authorization: Bearer $ADMIN_TOKEN" \
  "$URL/feedback?artifact=feedback-detector"
```

Matches `artifact.id` exactly.

### Filter by submitter

```bash
curl -H "Authorization: Bearer $ADMIN_TOKEN" \
  "$URL/feedback?email=dev@example.com"
```

Matches the authenticated submitter's email (server-resolved; not a
client-supplied field).

### Date range

`received_from` / `received_to` are inclusive, ISO-8601 lexical, against the
server receive time:

```bash
curl -H "Authorization: Bearer $ADMIN_TOKEN" \
  "$URL/feedback?received_from=2026-05-01T00:00:00Z&received_to=2026-05-28T23:59:59Z"
```

### Pretty-print with `jq`

Dump the whole corpus and slice it locally:

```bash
# Compact: id + severity + summary, one record per line.
curl -sH "Authorization: Bearer $ADMIN_TOKEN" "$URL/feedback?limit=0" \
  | jq -c '.[] | {id, severity, summary}'

# High-severity records for one artifact, full JSON:
curl -sH "Authorization: Bearer $ADMIN_TOKEN" \
  "$URL/feedback?artifact=prd-writer&severity=high&limit=0" \
  | jq '.'

# Save the whole corpus to feed to a coding agent:
curl -sH "Authorization: Bearer $ADMIN_TOKEN" "$URL/feedback?limit=0" \
  > feedback.json
```

## 4. Filter reference

All filters are exact match (unless noted) and combined with **AND**.

| Param | Matches | Notes |
|-------|---------|-------|
| `artifact` | `artifact.id` | exact |
| `severity` | `severity` | must be `low \| medium \| high` (else `400`) |
| `confidence` | `confidence` | must be `low \| medium \| high` (else `400`) |
| `email` | submitter's user email | exact — the **user** filter (joins `users`) |
| `received_from` | server receive time `>=` | inclusive, ISO-8601 lexical |
| `received_to` | server receive time `<=` | inclusive, ISO-8601 lexical |
| `limit` | page size | default `100`. `limit=0` → all records. `limit < 0` / non-integer → `400`. |
| `offset` | records to skip | default `0`. `offset < 0` / non-integer → `400`. |

Each returned record carries two fields outside the ingest wire schema: `id`
(the server-assigned primary key, `fb_…` — the ingest body carries none) and
`submitterEmail` (resolved from the POSTing token). See
[service.md](service.md#get-feedback-pagination) for the full status contract.

## Common status codes

| Status | Meaning |
|--------|---------|
| `200` | OK. JSON array of stored records. |
| `400` | Bad pagination (`limit < 0`, non-integer `limit`/`offset`) or invalid `severity`/`confidence` value. |
| `401` | Missing/malformed/unknown bearer token. |
| `403` | Valid token but **not an admin** token. Mint with `--admin`. |

---

See also: [install.md](install.md) · [mcp.md](mcp.md) ·
[service.md](service.md) · [environment-variables.md](environment-variables.md).
