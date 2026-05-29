# Development

A short, copy-paste path to build and run **loopback** from a local checkout: run
the central service in Docker, mint per-user tokens, build + install the client
into your harness, exercise the loop, and read the stored record back.

> For a plain install (not development), end users run
> `npx @guidobuilds/loopback-setup` — see the [README](README.md). For deep reference
> (endpoints, MCP tools, installer flags, admin queries, env vars,
> troubleshooting) see [`docs/`](docs/README.md).

## Prerequisites

- **Docker** + the `docker compose` plugin (`docker info` must succeed)
- **Node.js ≥18** + **[Bun](https://bun.sh)** (to build the MCP bundle)
- **pnpm** (to build the installer; `npm` also works)
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

Copy each printed `lpbk_…` token (shown once). Auth is per-user, hashed at
rest — there is no shared server token. The DB persists in the
`feedback-data` volume.

## 2. Build the MCP server bundle + the installer

```bash
# MCP server bundle (consumed by the installer's prebuild step).
cd ../loopback && npm install && npm run build

# Installer (pulls the freshly-built bundle into setup/mcp-bundle/ as a prebuild step).
cd ../setup && pnpm install && pnpm build
```

## 3. Install into your harness from the local checkout

```bash
# Run the just-built installer directly (no npx round-trip):
HOME=$HOME node setup/dist/index.js claude-code \
  --service-url http://localhost:8080 \
  --token "<developer lpbk_… token>" \
  --yes
```

The installer writes `~/.loopback/config.json` (mode `0600`), extracts the MCP
bundle to `~/.loopback/mcp/server.bundle.js`, registers the MCP server with
the chosen harness, and copies the detector skill + `/harness-feedback`
command. Restart the harness. Confirm with `claude mcp list` /
`claude mcp get loopback`.

## 4. Verify the loop

In a running session, trigger feedback manually, then choose `[S]end`:

```
/harness-feedback prd-writer the PRD used a freeform structure instead of the Problem/Solution/Metrics template
```

Read it back with the **admin** token (use `curl`; there is no CLI for
reading feedback):

```bash
curl -H "Authorization: Bearer <admin lpbk_… token>" http://localhost:8080/feedback | jq '.'
```

You should see your `prd-writer` record. The store is append-only — send
again and the corpus gains another record. For the full containerized
end-to-end, run `bash service/e2e/run-e2e.sh`. See [`docs/admin.md`](docs/admin.md)
for the full set of filters and examples.

## Already have Loopback installed? (reconfigure)

The installer is **idempotent** and preserves your existing settings — it is
always safe to re-run.

- **Re-run `npx @guidobuilds/loopback-setup <agent>`** when you want to refresh the
  install (e.g. after rebuilding the MCP bundle, or to point at a new
  service URL).
- **Rotate credentials** by re-running the installer and answering `n` to
  "Use these credentials?", or directly with
  `npx @guidobuilds/loopback-setup --token <new> --service-url <new>`. The MCP server
  picks up the new values from `~/.loopback/config.json` on its next launch.
- **Uninstall** with `npx @guidobuilds/loopback-setup --remove [agent]` (add `--all` to
  also delete `~/.loopback/`).

## Teardown

```bash
cd service
docker compose down       # stop, keep the DB volume
docker compose down -v     # also delete the feedback-data volume (DB + tokens gone)
```

---

Deep reference → see [`docs/`](docs/README.md).
