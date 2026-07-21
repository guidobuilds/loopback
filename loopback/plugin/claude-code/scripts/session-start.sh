#!/bin/sh
# loopback SessionStart hook.
#
# Builds the "harness-surface inventory" — the ids of the skills and agents
# installed in this harness — caches it under ~/.loopback/state/<session>/, and
# injects a compact `additionalContext` so the feedback-detector's Step 3
# attribution can name a REAL component ("you are correcting `prd-writer`")
# instead of guessing.
#
# This hook NEVER decides that a defect occurred and NEVER sends anything. It
# only primes context and writes local state. It ALWAYS exits 0 — a priming
# failure must never break the session.
set -u

DIR=${0%/*}
# shellcheck source=./lib.sh
. "${DIR}/lib.sh" 2>/dev/null || true

emit_empty() { printf '{}'; exit 0; }

IN=$(cat 2>/dev/null) || IN=''
command -v lb_have_jq >/dev/null 2>&1 || emit_empty
lb_have_jq || emit_empty

SID=$(printf '%s' "$IN" | jq -r '.session_id // "unknown"' 2>/dev/null) || SID=unknown
STATE=$(lb_state_dir "$SID") || emit_empty

SKILLS=$(lb_list_skills)
AGENTS=$(lb_list_agents)

# Cache the inventory as JSON for the other hooks / the model to read locally.
{
  printf '{"skills":'
  printf '%s' "$SKILLS" | lb_json_array
  printf ',"agents":'
  printf '%s' "$AGENTS" | lb_json_array
  printf '}\n'
} > "${STATE}/inventory.json" 2>/dev/null || true

SKILL_CSV=$(printf '%s' "$SKILLS" | paste -sd ',' - 2>/dev/null)
AGENT_CSV=$(printf '%s' "$AGENTS" | paste -sd ',' - 2>/dev/null)

CTX=$(printf '%s' "loopback priming for the feedback-detector skill (Step 3 attribution only — this NEVER means a defect occurred). Installed skills=[${SKILL_CSV}]; agents=[${AGENT_CSV}]. If this session the user corrects output that came from one of these NAMED components, attribute the lesson to that id and run the consent gate exactly as the skill dictates. If a correction cannot be tied to one of these components, stay silent (precision bias). Never raise more than one candidate per artifact per session, and never send anything without an explicit [S]end.")

jq -n --arg c "$CTX" \
  '{hookSpecificOutput:{hookEventName:"SessionStart",additionalContext:$c}}' \
  2>/dev/null || emit_empty
exit 0
