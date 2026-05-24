# Development

A linear, copy-paste runbook to work on **loopback** end to end **from a local
checkout**: run the central service in **Docker**, mint per-user tokens, **build** the
client and install it into Claude Code with the **local** CLI, exercise the loop, and
read the stored record back.

> For a plain install (not development), end users run `npx @guidobuilds/loopback
> setup` — see the [README](README.md). This guide builds and installs from source.

The service is an **append-only feedback store** — it stores every received
(de-identified) record for later review. There is no registry, owner resolution,
dedup, or issue fan-out (those are on the roadmap).

> Every command, path, and env var below is grounded in the repo files
> (`service/Dockerfile`, `service/docker-compose.yml`, `service/e2e/run-e2e.sh`). Run
> them on a machine with a working Docker daemon (`docker info` must succeed).

---

## 0. Prerequisites

On a host with a **running Docker daemon**:

- **Docker** + the `docker compose` plugin (`docker info` must succeed)
- **Claude Code CLI** (`claude`) — loopback registers its MCP server + hooks here
- **Node.js** + **[Bun](https://bun.sh)** — to build the MCP bundle and run the local CLI / MCP server
- **git**, **openssl**, **curl**

You do **not** need a local Python install: the service image is built from
`python:3.13-slim` (`service/Dockerfile`), so Python and the service deps live
inside the container.

---

## 1. Get the repo

```bash
git clone <your-fork-or-origin> loopback
cd loopback
```
---

## 2. Auth model (per-user, hashed tokens)

There is **no shared server token**. Auth is per-user bearer tokens, **hashed at
rest** in the service DB. An admin mints them with the service's `issue_token.py`
CLI (which writes directly to the DB, so the first admin bootstraps with no
chicken-and-egg). You will mint two tokens in step 3 once the service is up:

- an **admin** token for yourself (admin tokens can read `GET /feedback`), and
- a **developer** token for the client (any valid token can `POST /feedback`).

The plaintext is shown **once** at issuance and is not recoverable; re-issue to
rotate (the table is append-only).

---

## 3. Run the central service in Docker

The service exposes `8080` and persists its SQLite DB under `/data` in the
container. The image's `DB_PATH` defaults to `/data/loopback.db`
(`service/Dockerfile`), so mounting a volume at `/data` makes the DB survive
restarts. The service takes **no token env var**.

### Option A — docker compose (recommended)

`service/docker-compose.yml` publishes `8080:8080` and mounts the named volume
`feedback-data` at `/data`. It carries no token env var (auth is DB-backed).

```bash
cd service/
docker compose up --build -d
```

### Option B — plain docker build / run

```bash
cd service/
docker build -t loopback-svc:local .
docker run -d --name loopback-svc \
  -v feedback-data:/data \
  -p 8080:8080 \
  loopback-svc:local
```

### Wait for health (both options)

`GET /healthz` returns `{"status":"ok"}` with HTTP 200 once the app is up:

```bash
for i in $(seq 1 30); do curl -fs localhost:8080/healthz && break; sleep 1; done
echo
curl -s -o /dev/null -w '%{http_code}\n' localhost:8080/healthz   # expect 200
```

### Mint your tokens (against the running container's DB)

Run `issue_token.py` inside the container so it writes to the same `DB_PATH`.
Copy each printed `lpbk_...` token; it is shown only once.

```bash
# compose:
docker compose exec loopback-svc python3 issue_token.py --email you@example.com --admin
docker compose exec loopback-svc python3 issue_token.py --email dev@example.com
# plain run:
docker exec loopback-svc python3 issue_token.py --email you@example.com --admin
docker exec loopback-svc python3 issue_token.py --email dev@example.com
```

Export the two tokens in the shell you will use for the rest of this guide:

```bash
export LOOPBACK_TOKEN="<the developer lpbk_... token>"   # client bearer (used in step 4)
export ADMIN_TOKEN="<the admin lpbk_... token>"          # to read GET /feedback (step 6b)
```

---

## 4. Build + install loopback from the checkout

In development you run loopback from the local checkout (not the published npm
package). Build the self-contained MCP bundle, then install it into Claude Code with
the **local** CLI — `node cli/index.js setup` registers the MCP server, the detector
skill, the `/harness-feedback` command, and the hooks directly into Claude Code's
config (no marketplace, no plugin, no manual edits). Pass the Docker service URL and
the **developer** token you exported in step 3:

```bash
cd /path/to/loopback/loopback
npm install        # dev deps: @modelcontextprotocol/sdk, ajv, ajv-formats, zod
npm run build      # build mcp/server.bundle.js (uses bun)
node cli/index.js setup claude-code \
  --ingest-url http://localhost:8080/feedback \
  --token "$LOOPBACK_TOKEN"
```

The client runs on the **host** and the container publishes `8080` on `localhost`
(step 3 `-p 8080:8080`), so plain **`localhost`** works — no `host.docker.internal`.

`setup` is **idempotent** (safe to re-run) and preserves your existing config. It
registers the MCP server with the **absolute** path to your checkout's
`mcp/server.bundle.js`, so re-run it after a `git pull` that rebuilds the bundle, or
if you move the checkout (`node cli/index.js uninstall` reverses it). Omit
`claude-code` to auto-detect every installed agent.

---

## 5. Verify the MCP server is registered

`setup` baked the ingest URL + developer token into the user-scope MCP config, so
there's nothing to export. Confirm it registered:

```bash
claude mcp list            # should list `loopback`
claude mcp get loopback    # shows the command (node <bundle>) + env
```

Restart Claude Code; the `loopback` tools (e.g. `submit_feedback`) and the
`/harness-feedback` command are now available, and the four hooks are wired into
`~/.claude/settings.json`. The originating harness is **auto-detected at submit
time** — nothing else to configure.

> If the tools don't appear, run `claude mcp get loopback` to confirm the bundle
> path and `--ingest-url`/`--token`, then re-run `node cli/index.js setup` (step 4). Asking the model
> to "list your MCP tools" is unreliable in headless `-p` runs; trust `claude mcp
> list` / `--debug-file` MCP startup logs instead.

---

## 6. Exercise the loop + verify

### 6a. Trigger feedback (deterministic path)

In a running Claude Code session (loopback installed via step 4; restart Claude Code
after `setup`), run the manual command. It runs the same synthesize → consent → submit
flow as the detector skill:

```
/harness-feedback prd-writer the PRD used a freeform structure instead of the Problem/Solution/Metrics template
```

Claude identifies the active skill/agent, stamps `artifact.{id,kind,version}`
(and optionally `artifact.repo` from the working dir's git remote), synthesizes a
generalizable lesson, redacts the excerpt, and renders the consent gate verbatim
(no owner is resolved or shown — there is no registry):

```
Possible skill defect detected — send feedback to the owner?

  Skill:    prd-writer  (<version>)
  Lesson:   <synthesized generalizable lesson>
  Evidence (redacted, this is exactly what is sent):
            "<redacted excerpt>"   (your file paths and names removed)
  Severity: <low|medium|high>     Confidence: <low|medium|high>

  [S]end   [E]dit lesson/excerpt   [D]ecline   [N]ever for this skill
```

Choose **`[S]end`**. Nothing is transmitted without this explicit consent. On
`[S]end`, loopback calls `submit_feedback` (surfaced in Claude Code as
`mcp__loopback__submit_feedback`), which re-redacts, validates against the wire
contract, stamps `anonUserId` + `client.{plugin,harness}`, and POSTs to the configured
ingest URL with the developer bearer token.

### 6b. Read back the stored record via `GET /feedback`

`GET /feedback` is the first-class read-back that lists **all** stored records.
It is **admin-only**, so use the `ADMIN_TOKEN` from step 3 (the developer token
gets `403` here):

```bash
curl -s -H "Authorization: Bearer $ADMIN_TOKEN" localhost:8080/feedback
```

A successful loop looks like a JSON array containing your record for `artifact.id =
prd-writer`, carrying a `serverId` (`fb_srv_...`), a stamped `anonUserId`, and
`client.plugin` like `loopback@0.0.1`. The stored `summary`/
`evidenceExcerpt` are the redacted text (redaction held — no file paths/secrets).

The store is **append-only**: send feedback again and the array gains **another**
record (no dedup/clustering — every received record is kept).

---

## 7. (Optional) Run the containerized E2E

`service/e2e/run-e2e.sh` is the self-contained end-to-end that **drives the
container**, not bare uvicorn. It:

1. Requires a running Docker daemon (fails loudly otherwise).
2. `docker build`s the image (`loopback-svc:e2e`) and `docker run`s it on
   port `8080` (no token env var — auth is DB-backed).
3. Polls `/healthz` until 200, then **mints its own tokens** inside the container
   via `issue_token.py` (a developer token for the POST, an admin token for the
   read-back).
4. Submits a record to `POST /feedback` with the developer token as bearer (it
   posts the canonical fixture `service/tests/fixtures/record.valid.json`). The
   full MCP → service path is covered separately by `loopback/test/e2e-local.js`.
5. Reads back via `GET /feedback` with the admin token and asserts the stored
   record(s) are **schema-valid** (against `feedback-record.schema.json`, via a
   throwaway venv + `jsonschema`) and that each carries a server id (`serverId`
   starting `fb_srv_`).

```bash
bash /path/to/loopback/service/e2e/run-e2e.sh
# expect: "E2E PASS: loop closed"
```

Note: the script needs `python3` available on the **host** (only to create a venv
for `jsonschema` validation); the service itself still runs entirely in Docker.

---

## 8. Teardown

```bash
# Option A (compose): stop the service and remove the data volume
cd service/
docker compose down            # keep the volume
docker compose down -v         # also delete the feedback-data volume (DB is gone)

# Option B (plain run):
docker rm -f loopback-svc
docker volume rm feedback-data   # deletes the persisted DB
```

The DB lives in the named volume `feedback-data` (mounted at `/data`, file
`/data/loopback.db`). Keep the volume to keep stored records across
restarts; remove it to start clean.

---

## 9. Troubleshooting

- **`401 unauthorized` on `POST /feedback` or `GET /feedback`** — the presented
  bearer token does not match any row in the service's `tokens` table (it was never
  issued, was issued against a different DB, or was mistyped/expired-by-rotation).
  The app fails closed: an unknown/missing token is 401. Mint a token with
  `issue_token.py` against the **same** DB the service uses (step 3) and pass it to
  `node cli/index.js setup … --token …` (step 4; re-run to update it).
- **`403 forbidden` on `GET /feedback`** — the token is valid but **not an admin**
  token. Reading the whole corpus requires an admin token (mint one with
  `issue_token.py --admin`); a developer token can only `POST`.
- **`loopback` tools not exposed in Claude Code** — run `claude mcp get loopback`
  to confirm `setup` registered the server (command `node <…/mcp/server.bundle.js>`
  plus the ingest URL/token). If it's missing, re-run `node cli/index.js setup
  claude-code --ingest-url … --token …` and **restart** Claude Code. Asking the model to "list
  your MCP tools" is unreliable in headless `-p` runs; trust `claude mcp list`.
- **Stored records disappear after a restart** — the DB was not on a persisted
  volume. Make sure you ran with `-v feedback-data:/data` (or compose, which mounts
  it). `docker compose down -v` / `docker volume rm feedback-data` intentionally
  deletes it. Note: minted tokens live in the **same** DB, so wiping the volume
  also removes all issued tokens — re-mint after a clean start.
- **Minted token does not work** — make sure you ran `issue_token.py` **inside the
  container** (so it wrote to the container's `DB_PATH`), copied the full `lpbk_...`
  value (it is shown only once), and used the admin token for `GET /feedback`.
