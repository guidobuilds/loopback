#!/usr/bin/env bash
# C1 — Detector precision scenario suite (design §3, plan Group C / C1).
#
# Drives the loopback plugin's feedback-detector skill (A7) through 5
# synthetic scenarios and asserts the precision contract:
#
#   TP1  defect, explicit correction   -> consent gate RAISED   (marker present)
#   TP2  defect, same-file revert       -> consent gate RAISED   (marker present)
#   FP1  iteration, new requirement     -> SILENT                (marker absent)
#   FP2  unattributable                 -> SILENT                (marker absent)
#   FP3  muted skill                     -> SILENT                (marker absent)
#
# The consent-gate marker is the distinctive sentinel token the SKILL.md emits as
# the gate's first line ONLY when the gate is actually rendered to the user:
#   HFB-CONSENT-GATE-v1
# (a unique token avoids false matches when the detector merely quotes the
# human-readable gate phrase while explaining why it is staying silent).
#
# Each scenario is a fixture under scenarios/*.json with: id, expect (gate|silent),
# an optional `mute` (skill id to mute first), and a self-contained `prompt` (a
# synthetic transcript + primed turn state instructing the model to apply the
# detector skill at the turn boundary).
#
# This suite is MODEL-DRIVEN: it actually runs a nested `claude` against the
# plugin and inspects real output. It does NOT pattern-match a canned answer.
# If the nested-claude path is unavailable/unreliable in this environment, the
# runner exits 2 (ENV-UNAVAILABLE) and reports honestly, rather than faking PASS.
#
# Exit codes:
#   0  all 5 scenarios matched their expectation (precision contract holds)
#   1  at least one scenario FAILED (precision regression — release blocker)
#   2  the nested-claude path is unavailable in this environment (cannot judge)
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "${HERE}/../.." && pwd)"
PLUGIN="${PLUGIN:-${REPO}/loopback}"
SCEN_DIR="${HERE}/scenarios"
MARKER="HFB-CONSENT-GATE-v1"

# Per-scenario wall-clock budget (seconds). A real model turn takes a while;
# keep generous but bounded. Override with SCENARIO_TIMEOUT=<sec>.
SCENARIO_TIMEOUT="${SCENARIO_TIMEOUT:-300}"

# --- preconditions -----------------------------------------------------------
command -v claude >/dev/null 2>&1 || {
  echo "ENV-UNAVAILABLE: 'claude' CLI not found on PATH; cannot drive the model-driven suite." >&2
  exit 2
}
command -v jq >/dev/null 2>&1 || {
  echo "ENV-UNAVAILABLE: 'jq' not found; cannot parse scenario fixtures." >&2
  exit 2
}
claude mcp get loopback >/dev/null 2>&1 || {
  echo "ENV-UNAVAILABLE: loopback is not installed in Claude Code. Run" >&2
  echo "  npx @guidobuilds/loopback config claude-code --service-url <url> --token <tok>" >&2
  echo "first (or 'node ${PLUGIN}/cli/index.js config claude-code ...' from a checkout)." >&2
  exit 2
}
[ -d "${SCEN_DIR}" ] || { echo "FAIL: scenarios dir missing: ${SCEN_DIR}" >&2; exit 1; }

# Run a prompt against the plugin via nested claude. stdin is redirected from
# /dev/null so claude does not stall waiting on a piped-but-empty stdin. The
# given CLAUDE_PLUGIN_DATA isolates per-scenario mute state. Combined out+err.
drive() {
  local data_dir="$1" prompt="$2"
  # loopback is installed via `loopback config` (plugin-less); claude reads it from
  # the user config. LOOPBACK_DATA_DIR isolates per-scenario state (mutes) — the MCP
  # server claude spawns inherits it.
  LOOPBACK_DATA_DIR="${data_dir}" \
    claude -p "${prompt}" </dev/null 2>&1
}

# --- self-probe: is nested-claude usable here at all? ------------------------
# A cheap deterministic probe. If even this produces no usable output, the
# environment cannot run the suite and we must say so (not fake results).
PROBE_DATA="$(mktemp -d)"
PROBE_OUT="$(drive "${PROBE_DATA}" "Reply with exactly the token DETECTOR_SUITE_PROBE_OK and nothing else.")"
rm -rf "${PROBE_DATA}" 2>/dev/null || true
if ! printf '%s' "${PROBE_OUT}" | grep -q "DETECTOR_SUITE_PROBE_OK"; then
  echo "ENV-UNAVAILABLE: nested 'claude -p' did not return usable output in this environment." >&2
  echo "  probe output (first 5 lines):" >&2
  printf '%s\n' "${PROBE_OUT}" | head -5 | sed 's/^/    /' >&2
  echo "  -> Run this suite on a host/interactive session where nested claude executes plugin skills." >&2
  exit 2
fi

# --- run scenarios -----------------------------------------------------------
pass=0 fail=0 total=0
declare -a results=()

for f in "${SCEN_DIR}"/*.json; do
  [ -e "$f" ] || continue
  total=$((total + 1))

  id="$(jq -r '.id' "$f")"
  title="$(jq -r '.title // ""' "$f")"
  expect="$(jq -r '.expect' "$f")"          # gate | silent
  mute_id="$(jq -r '.mute // empty' "$f")"
  prompt="$(jq -r '.prompt' "$f")"

  # Fresh, isolated per-scenario state dir (no stale mutes leak between cases).
  data_dir="$(mktemp -d)"
  if [ -n "${mute_id}" ]; then
    LOOPBACK_DATA_DIR="${data_dir}" node "${PLUGIN}/cli/index.js" mute "${mute_id}" >/dev/null 2>&1 || {
      echo "[$id] SETUP-ERROR: could not mute ${mute_id}" >&2
    }
  fi

  out="$(drive "${data_dir}" "${prompt}")"
  rm -rf "${data_dir}" 2>/dev/null || true

  # Did the consent-gate sentinel appear? (fixed-string, case-sensitive exact
  # substring — only emitted when the gate is truly rendered).
  if printf '%s' "${out}" | grep -qF "${MARKER}"; then
    observed="gate"
  else
    observed="silent"
  fi

  if [ "${observed}" = "${expect}" ]; then
    verdict="PASS"; pass=$((pass + 1))
  else
    verdict="FAIL"; fail=$((fail + 1))
  fi

  printf '%-5s %-4s expect=%-7s observed=%-7s  %s\n' \
    "[$id]" "${verdict}" "${expect}" "${observed}" "${title}"
  results+=("$id ${verdict} (expect=${expect} observed=${observed})")

  # On FAIL, surface a short evidence excerpt for debugging.
  if [ "${verdict}" = "FAIL" ]; then
    echo "      --- output excerpt (last 12 lines) ---" >&2
    printf '%s\n' "${out}" | tail -12 | sed 's/^/      /' >&2
    echo "      --------------------------------------" >&2
  fi
done

echo "----------------------------------------------------------------"
echo "detector precision suite: ${pass}/${total} passed, ${fail} failed"

if [ "${total}" -ne 5 ]; then
  echo "WARN: expected 5 scenarios, found ${total}." >&2
fi

[ "${fail}" -eq 0 ] && [ "${total}" -ge 5 ]
