#!/usr/bin/env bash
# Feedback-detector performance suite — entrypoint.
#
# This is a thin wrapper around the scale runner+grader in `eval.py`. It exists
# so the historical `bash tests/detector/run.sh` entrypoint keeps working and
# preserves the same exit-code contract:
#
#   0  every scenario matched its expectation (the contract holds)
#   1  at least one scenario FAILED (a performance regression)
#   2  the nested-claude path is unavailable here (cannot judge — reported honestly)
#
# The suite drives the *real* shipped `feedback-detector` SKILL.md through a
# corpus of synthetic turn-boundary scenarios under scenarios/{precision,recall,
# redaction}/ and grades the model's output along three dimensions:
#
#   precision  must stay SILENT on iteration / scope / preference / ambiguous /
#              unattributable / Tier-2-only corrections (the prime directive)
#   recall     must RAISE the consent gate on a genuine, attributable defect
#   redaction  must raise the gate AND scrub PII / secrets / paths from the
#              excerpt before showing it (show-exactly-what-is-sent)
#
# The skill is loaded into the nested `claude` via --append-system-prompt, so no
# loopback install / MCP registration is required: the scenarios stop at the
# consent-gate render and never call submit_feedback.
#
# All flags pass straight through to eval.py, e.g.:
#   bash tests/detector/run.sh --dimension redaction
#   bash tests/detector/run.sh --jobs 8 --json /tmp/grading.json
#   bash tests/detector/run.sh --id REC-01
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"

command -v claude >/dev/null 2>&1 || {
  echo "ENV-UNAVAILABLE: 'claude' CLI not found on PATH; cannot drive the model-driven suite." >&2
  exit 2
}
command -v python3 >/dev/null 2>&1 || {
  echo "ENV-UNAVAILABLE: 'python3' not found; cannot run the eval harness." >&2
  exit 2
}

exec python3 "${HERE}/eval.py" "$@"
