#!/bin/sh
# Shared helpers for the loopback plugin hooks. SOURCED by each hook script,
# never executed directly.
#
# INVARIANTS (do not break):
#   * A hook must NEVER fail a session. Every function is side-effect-safe and
#     returns non-zero only so the caller can degrade to an empty JSON output.
#   * Hooks PRIME context and write LOCAL state only. They never decide that a
#     defect occurred and never send anything off the machine.
#   * State lives under ~/.loopback/state/<session>/ and never leaves the box.

# True iff jq is available. When it is not, every hook degrades to `{}`.
lb_have_jq() { command -v jq >/dev/null 2>&1; }

# lb_state_dir <session_id> -> echoes ~/.loopback/state/<session_id> (0700),
# creating it if needed. Returns non-zero if it cannot be created.
lb_state_dir() {
  _sid=${1:-unknown}
  # Reject a session id with a slash so it can't escape the state root.
  case $_sid in
    */*|"") _sid=unknown ;;
  esac
  _base=${HOME}/.loopback/state
  mkdir -p "${_base}/${_sid}" 2>/dev/null || return 1
  chmod 700 "${HOME}/.loopback" "${_base}" "${_base}/${_sid}" 2>/dev/null
  printf '%s' "${_base}/${_sid}"
}

# lb_list_skills -> newline-separated, de-duplicated ids of installed skills.
# Reads the `name:` frontmatter of each SKILL.md (user + project scope); falls
# back to the directory name. Bounded to the frontmatter (first 30 lines).
lb_list_skills() {
  for _d in "${HOME}/.claude/skills"/*/ "${PWD}/.claude/skills"/*/; do
    [ -f "${_d}SKILL.md" ] || continue
    _n=$(sed -n '1,30{s/^name:[[:space:]]*//p;}' "${_d}SKILL.md" 2>/dev/null \
      | head -1 | tr -d '"'\''' | tr -d '\r')
    [ -n "$_n" ] || _n=$(basename "$_d")
    printf '%s\n' "$_n"
  done 2>/dev/null | sort -u
}

# lb_list_agents -> newline-separated, de-duplicated ids of installed agents
# (~/.claude/agents/*.md + project .claude/agents/*.md). Uses the `name:`
# frontmatter when present, else the filename stem.
lb_list_agents() {
  for _f in "${HOME}/.claude/agents"/*.md "${PWD}/.claude/agents"/*.md; do
    [ -f "$_f" ] || continue
    _n=$(sed -n '1,30{s/^name:[[:space:]]*//p;}' "$_f" 2>/dev/null \
      | head -1 | tr -d '"'\''' | tr -d '\r')
    [ -n "$_n" ] || _n=$(basename "$_f" .md)
    printf '%s\n' "$_n"
  done 2>/dev/null | sort -u
}

# lb_json_array <<lines  -> a JSON string array of the non-empty input lines.
# Requires jq (callers guard with lb_have_jq first).
lb_json_array() {
  jq -R -s 'split("\n") | map(select(length > 0))'
}
