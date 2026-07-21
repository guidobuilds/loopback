#!/bin/sh
# loopback UserPromptSubmit hook.
#
# A cheap (<=2s), HARD-DEBOUNCED priming nudge. It injects the fuller reminder
# ONLY when both are true:
#   (a) the agent has produced artifacts this session (write-log is non-empty), and
#   (b) the user's message carries correction language (a small lexicon).
# and at most once per cooldown window. Otherwise it stays completely silent.
#
# The nudge reaffirms silence-by-default and NEVER asserts that a defect
# occurred — the feedback-detector's four gates remain authoritative. Always
# exits 0.
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

# (a) The agent must have written something this session.
[ -s "${STATE}/write-log.ndjson" ] || emit_empty

# (b) Correction lexicon. This is a heuristic only: a miss just means the fuller
#     nudge doesn't fire this turn — the model still self-checks every turn.
PROMPT=$(printf '%s' "$IN" | jq -r '.prompt // ""' 2>/dev/null)
CORR='no|nope|wrong|incorrect|not (the|right|correct|what)|forgot|revert|reverted|undo|redo|stop doing|always|never do|should not|shouldn|that is wrong|thats wrong|bad format|wrong format|do not|dont'
printf '%s' "$PROMPT" | grep -Eiq "(^|[^[:alnum:]])(${CORR})([^[:alnum:]]|$)" || emit_empty

# (c) Debounce: don't re-prime within the cooldown window (seconds).
COOLDOWN=${LOOPBACK_PRIME_COOLDOWN:-90}
NOW=$(date +%s 2>/dev/null || echo 0)
MARK="${STATE}/last-primed"
if [ -f "$MARK" ] && [ "$NOW" -gt 0 ] 2>/dev/null; then
  LAST=$(cat "$MARK" 2>/dev/null || echo 0)
  if [ "$LAST" -gt 0 ] 2>/dev/null && [ $((NOW - LAST)) -lt "$COOLDOWN" ] 2>/dev/null; then
    emit_empty
  fi
fi
printf '%s' "$NOW" > "$MARK" 2>/dev/null || true

# Build the nudge from the recent write-log tail + the cached inventory.
TAIL=$(tail -n 5 "${STATE}/write-log.ndjson" 2>/dev/null \
  | jq -r '.file_path // empty' 2>/dev/null | paste -sd ',' - 2>/dev/null)
INV=''
[ -f "${STATE}/inventory.json" ] && INV=$(jq -r \
  '((.skills // []) + (.agents // [])) | join(", ")' \
  "${STATE}/inventory.json" 2>/dev/null)

CTX=$(printf '%s' "loopback priming: the user's latest message may be correcting earlier output. Run the feedback-detector self-check for THIS turn boundary now. Files written this session: [${TAIL}]. Installed components you may attribute to: [${INV}]. Only raise the consent gate if a real skill/agent DEFECT clears every gate; if this is iteration, a new requirement, a preference, or unattributable, stay silent. Never raise more than one candidate per artifact per session, and never send anything without an explicit [S]end.")

jq -n --arg c "$CTX" \
  '{hookSpecificOutput:{hookEventName:"UserPromptSubmit",additionalContext:$c}}' \
  2>/dev/null || emit_empty
exit 0
