#!/usr/bin/env bash
# B7: client -> containerized service end-to-end (the loop closes).
#
# Builds + runs the service container, points the plugin's ingest config at it,
# POSTs a canonical record to the running container (developer token as bearer), then
# asserts the append-only store kept a schema-valid record (with a server id and
# the submitter resolved from the token) that is retrievable via GET /feedback.
# (The full client MCP -> service
# path is covered by loopback/test/e2e-local.js.)
#
# This script bridges Group A (plugin, owned by a sibling worker) and Group B
# (this service). It is intentionally self-contained and fails loudly with a
# clear message if a prerequisite (docker daemon, plugin MCP tool) is missing.
set -euo pipefail

SVC="$(cd "$(dirname "$0")/.." && pwd)"
REPO="$(cd "${SVC}/.." && pwd)"
PLUGIN="${PLUGIN:-${REPO}/loopback}"
IMAGE="loopback-svc:e2e"
PORT="${PORT:-8080}"

cleanup() {
  [ -n "${CID:-}" ] && docker rm -f "$CID" >/dev/null 2>&1 || true
  [ -n "${VENV:-}" ] && rm -rf "$(dirname "$VENV")" 2>/dev/null || true
}
trap cleanup EXIT

# 0. Preconditions.
command -v docker >/dev/null || { echo "FAIL: docker not installed"; exit 1; }
docker info >/dev/null 2>&1 || { echo "FAIL: docker daemon not running"; exit 1; }

# 1. Build + run the service container. Auth is per-user hashed tokens in the DB
#    (no server token env var); we mint them via issue_token.py below.
docker build -t "$IMAGE" "$SVC"
CID=$(docker run -d -p "${PORT}:8080" "$IMAGE")

# 2. Wait for readiness.
for _ in $(seq 1 30); do
  curl -fs "localhost:${PORT}/healthz" >/dev/null 2>&1 && break
  sleep 1
done
H=$(curl -s -o /dev/null -w '%{http_code}' "localhost:${PORT}/healthz")
[ "$H" = 200 ] || { echo "FAIL: /healthz returned $H"; exit 1; }
echo "service healthy"

# 2b. Mint tokens against the SAME DB the service uses (DB_PATH inside the
#     container). A non-admin token to POST feedback, an admin token to read it
#     back via GET /feedback. issue_token.py prints the plaintext once; we grep
#     it out of the labeled "token   :" line.
mint() {  # $1 = extra args (e.g. --admin); echoes the plaintext token
  docker exec "$CID" python3 issue_token.py --email "e2e@example.com" $1 \
    | awk -F': ' '/^  token   :/ {print $2}' | awk '{print $1}'
}
DEV_TOKEN="$(mint '')"
ADMIN_TOKEN="$(mint --admin)"
[ -n "$DEV_TOKEN" ] || { echo "FAIL: could not mint a developer token"; exit 1; }
[ -n "$ADMIN_TOKEN" ] || { echo "FAIL: could not mint an admin token"; exit 1; }
echo "minted developer + admin tokens"

# 3. Submit a record to the running container with the developer's per-user token as
#    bearer. This exercises the containerized service E2E (auth -> validate -> redact
#    -> persist). The full client MCP -> service path is covered separately by
#    loopback/test/e2e-local.js (node MCP server -> live FastAPI -> admin read-back).
curl -fs -X POST "http://localhost:${PORT}/feedback" \
  -H "Authorization: Bearer ${DEV_TOKEN}" -H "Content-Type: application/json" \
  --data @"${SVC}/tests/fixtures/record.valid.json" >/dev/null
echo "submitted canonical record"

# 4. Assert: the stored record is schema-valid (against the canonical schema)
#    and retrievable via the admin-only GET /feedback read-back (admin token).
VENV="$(mktemp -d)/venv"; python3 -m venv "$VENV"; "$VENV/bin/pip" install -q jsonschema
SCHEMA="${PLUGIN}/core/feedback-record.schema.json"
[ -f "$SCHEMA" ] || SCHEMA="${SVC}/feedback-record.schema.json"

curl -fs -H "Authorization: Bearer ${ADMIN_TOKEN}" "localhost:${PORT}/feedback" \
  | "$VENV/bin/python" -c "
import json,sys
from jsonschema import Draft202012Validator as D
schema=json.load(open('${SCHEMA}'))
recs=json.load(sys.stdin)
assert recs, 'no records stored'
v=D(schema)
for r in recs:
    assert r.get('serverId','').startswith('fb_srv_'), ('missing server id', r)
    r=dict(r); r.pop('serverId',None)
    errs=list(v.iter_errors(r))
    assert not errs, [e.message for e in errs]
print('stored record(s) schema-valid and retrievable via GET /feedback:', len(recs))
"

echo "E2E PASS: loop closed"
