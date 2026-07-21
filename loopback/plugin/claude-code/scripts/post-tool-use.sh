#!/bin/sh
# loopback PostToolUse hook (Write|Edit|MultiEdit|NotebookEdit).
#
# Appends the written file_path to the per-session write-log so the detector's
# same-file-revert signal (Step 1, Signal 2) is deterministic even after the
# original write has scrolled out of the truncated transcript.
#
# Honest limitation: the PostToolUse payload has no "active skill" field, so
# this hook records the file_path deterministically and leaves WHICH skill/agent
# produced it to the model (aided by the SessionStart inventory). It does not
# fabricate attribution.
#
# Silent (emits `{}`), never decides anything, always exits 0.
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

TS=$(date +%s 2>/dev/null || echo 0)
LINE=$(printf '%s' "$IN" | jq -c --arg ts "$TS" \
  '{ts: ($ts|tonumber? // 0), tool: .tool_name, file_path: (.tool_input.file_path // .tool_input.notebook_path // null), cwd: (.cwd // null)}' \
  2>/dev/null)

# Only log entries that actually name a file.
if [ -n "$LINE" ]; then
  FP=$(printf '%s' "$LINE" | jq -r '.file_path // empty' 2>/dev/null)
  [ -n "$FP" ] && printf '%s\n' "$LINE" >> "${STATE}/write-log.ndjson" 2>/dev/null
fi

emit_empty
