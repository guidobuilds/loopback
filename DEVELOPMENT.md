# Development

A short, copy-paste path to build and run **loopback** from a local checkout: run
the central service in Docker, mint per-user tokens, build + install the client
into your harness, exercise the loop, and read the stored record back.

> For a plain install (not development), end users run
> `npx @guidobuilds/loopback auth` then `npx @guidobuilds/loopback setup <harness>` — see the [README](README.md). For deep reference (endpoints, CLI flags, MCP tools, env vars, troubleshooting) see [`docs/`](docs/README.md).

## Prerequisites

- **Docker** + the `docker compose` plugin (`docker info` must succeed)
- **Node.js ≥18** + **[Bun](https://bun.sh)** (to build the MCP bundle / run the CLI)
- A harness CLI (e.g. `claude`)
- `curl`, `openssl`, `git`

You do not need a local Python install: the service runs inside the container.

## 1. Run the test service

```bash
cd service && docker compose up --build -d
curl -fs localhost:8080/healthz            # {"status":"ok"}

# mint a developer token (POST) and an admin token (GET /feedback):
docker compose exec loopback-svc python3 issue_token.py --email dev@example.com
docker compose exec loopback-svc python3 issue_token.py --email you@example.com --admin
```

Copy each printed `lpbk_…` token (shown once). Auth is per-user, hashed at rest — there is no shared server token. The DB persists in the `feedback-data` volume.

## 2. Build + install the CLI from the checkout

```bash
cd ../loopback && npm install && npm run build
# Step 2a: write credentials once (lives in ~/.loopback/config.json @ 0600)
node cli/index.js auth \
  --service-url http://localhost:8080 --token "<developer lpbk_… token>"
# Step 2b: install into the harness you want to test against
node cli/index.js setup claude-code --automatic-feedback-detection
```

The client runs on the host and the container publishes `8080` on `localhost`, so plain `localhost` works (no `host.docker.internal`). `auth` is the single source of credentials; `setup claude-code` registers the MCP server + detector skill + `/harness-feedback` command (+ hooks via the opt-in flag). Restart the harness. Confirm with `claude mcp list` / `claude mcp get loopback`.

## 3. Verify the loop

In a running session, trigger feedback manually, then choose `[S]end`:

```
/harness-feedback prd-writer the PRD used a freeform structure instead of the Problem/Solution/Metrics template
```

Read it back with the **admin** token (rotate creds first; `feedback list` reads from `~/.loopback/config.json`):

```bash
node cli/index.js feedback list
```

You should see your `prd-writer` record. The store is append-only — send again and the corpus gains another record. For the full containerized end-to-end, run `bash service/e2e/run-e2e.sh`.

## Already have Loopback installed? (reconfigure)

`setup <harness>` is **idempotent** and preserves your existing settings — it
is always safe to re-run.

- **Re-run `loopback setup <harness>`** only when something it baked in
  changed: after `npm run build` / moving the checkout (it stores the
  **absolute** path to `mcp/server.bundle.js`).
- **Rotate credentials** with `loopback auth --token … [--service-url …]`. No
  `setup <harness>` re-run needed — the MCP server picks up the new values
  from `~/.loopback/config.json` on its next launch.
- `node cli/index.js uninstall <harness>` (or `uninstall --all`) reverses the
  install.

## Teardown

```bash
cd service
docker compose down       # stop, keep the DB volume
docker compose down -v     # also delete the feedback-data volume (DB + tokens gone)
```

---

Deep reference → see [`docs/`](docs/README.md).
