# loopback-svc

Central service for the feedback loop. It **hosts the loopback MCP** (remote,
bearer-auth, at `/mcp`) **and** the **append-only feedback store**: it accepts
de-identified feedback records (via the MCP `submit_feedback` tool or `POST
/feedback`), re-checks redaction, and **stores every valid record** with its
identifying data. A token-guarded read-back endpoint (`GET /feedback`,
admin-only) lists all stored feedback for later review. There is no registry,
owner resolution, dedup/clustering, or issue fan-out.

- **Stack:** Python + FastAPI (hosts the MCP via the official `mcp` SDK);
  **SQLAlchemy 2.0** + **Alembic** over SQLite; per-user hashed-token bearer auth;
  Docker. Port `8080`.
- **Wire contract:** `feedback-record.schema.json` (single source of truth; kept
  in lockstep with the pydantic models by `tests/test_contract.py`).

## Quick start

```bash
docker compose up --build -d
curl -fs localhost:8080/healthz            # {"status":"ok"}
# mint a token (admin can read GET /feedback; default token can POST only):
docker compose exec loopback-svc python3 issue_token.py --email you@example.com --admin
```

Or run it locally with uvicorn:

```bash
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
DB_PATH=/tmp/loopback.db .venv/bin/alembic upgrade head
.venv/bin/uvicorn app.main:app --port 8080
.venv/bin/pytest -q                        # tests
bash e2e/run-e2e.sh                         # containerized end-to-end (needs docker)
```

## Tools

- `issue_token.py` — mint per-user tokens (writes hash-at-rest to the DB).
- `show_latest_feedback.py` — read-only, stdlib-only CLI that prints the latest
  stored records newest-first (`python show_latest_feedback.py [--db PATH] [--limit N]`).

## Documentation

- **Full service reference** (endpoints, status codes, filters/pagination, auth &
  token model, persistence/schema, troubleshooting) →
  [`../docs/service.md`](../docs/service.md)
- **Environment variables** (e.g. `DB_PATH`) →
  [`../docs/environment-variables.md`](../docs/environment-variables.md)
- **Run it end to end** → [`../DEVELOPMENT.md`](../DEVELOPMENT.md)
- **Docs index** → [`../docs/README.md`](../docs/README.md)
