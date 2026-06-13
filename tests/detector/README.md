# Feedback-detector performance suite

A model-driven evaluation suite for loopback's `feedback-detector` skill
(`loopback/skills/feedback-detector/SKILL.md`). It runs the **real shipped
skill** through a corpus of synthetic turn-boundary scenarios and grades the
model's output against per-scenario assertions, so we can measure the skill's
performance along the dimensions that matter for it.

## What it measures

| Dimension | Folder | Expectation | Why it matters |
|-----------|--------|-------------|----------------|
| **precision** | `scenarios/precision/` | stay **silent** | The skill's prime directive: a false positive interrupts the user and trains them to dismiss the gate, which is fatal to adoption. Most of the corpus lives here — iteration, additive scope, preference tweaks, ambiguous reactions, unattributable corrections, de-bounced repeats, and Tier-2-only signals must **not** raise a gate. |
| **recall** | `scenarios/recall/` | raise the **gate** | The skill must catch genuine, attributable defects — explicit corrections, same-file reverts, repeated re-instruction, repaired omissions — for both skills and subagents. |
| **redaction** | `scenarios/redaction/` | gate **+ scrubbed excerpt** | On a real defect whose evidence contains PII / secrets / paths, the skill must raise the gate **and** scrub the excerpt in-context before showing it (show-exactly-what-is-sent). The raw secret must never appear in the output; the canonical `[redacted-*]` placeholder must. |
| **synthesis** | `scenarios/synthesis/` | gate **+ rubric pass** | On a real defect, the lesson the skill writes must be clear, actionable, and **self-typed** — a reader can tell from the wording alone whether it is a technical/code defect or a behavioral/flow defect, and knows what to change. Prose quality can't be checked by substring, so these scenarios carry an `assertions.rubric` graded by a second nested `claude` (the rubric judge). |

The load-bearing signal is the consent-gate sentinel the skill emits as the
gate's first line **only** when it truly raises the gate:

```
HFB-CONSENT-GATE-v1
```

## How a scenario is driven

Each scenario is a self-contained synthetic transcript that primes a turn
boundary and asks the model to apply the detector. The harness loads the actual
`SKILL.md` into a nested `claude` via `--append-system-prompt`, so it tests the
**shipped skill text itself** and does **not** depend on loopback being installed
(no MCP registration required): the scenarios stop at the consent-gate render,
and `submit_feedback` is only ever called on an explicit `[S]end`.

## Running

```bash
# everything (defaults: 4 concurrent runs, 300s/scenario budget)
bash tests/detector/run.sh

# one dimension, or one scenario
bash tests/detector/run.sh --dimension redaction
bash tests/detector/run.sh --id REC-01

# tune concurrency / save a full grading report
bash tests/detector/run.sh --jobs 8 --json /tmp/grading.json

# dump each scenario's full model output (pass OR fail) to a directory, one
# file per id — the grading report omits the raw output, so use this to inspect
# the actual gate / Lesson a scenario produced
bash tests/detector/run.sh --dimension synthesis --save-outputs /tmp/outs
cat /tmp/outs/SYN-01.txt

# call the runner directly (same flags)
python3 tests/detector/eval.py --dimension precision
```

Exit codes: `0` all scenarios matched their expectation · `1` at least one
failed (a performance regression) · `2` the nested-`claude` path is unavailable
here (reported honestly rather than faking PASS) · `130` interrupted with Ctrl-C.

### Progress & interrupting

Each scenario drives a multi-second nested `claude`, so the runner streams a
timestamped, immediately-flushed log line as each scenario **starts** and
**finishes** (with a running `k/N` counter) rather than going silent until the
end. A **Ctrl-C** is handled cleanly: it terminates the in-flight nested runs,
then prints the per-dimension/overall summary for whatever finished so far
(labelled `PARTIAL`) and exits `130` — you never lose the work already done.

## Grading

A scenario **passes** iff all of:

1. observed gate/silent matches its `expect`, **and**
2. every `assertions.forbidden` substring is **absent** from the output (e.g. a
   raw API key or email never leaked), **and**
3. every `assertions.required` substring is **present** in the output (e.g. the
   `[redacted-token]` placeholder), **and**
4. if `assertions.rubric` is set, the second-pass **rubric judge** returns `PASS`
   (only evaluated when a gate was rendered — no gate means no lesson to grade).

The runner prints a per-scenario table plus per-dimension and overall pass
rates, and (with `--json`) writes a full report.

## Scenario schema

```json
{
  "id": "RED-02",
  "dimension": "redaction",
  "title": "redact API secret key in the evidence excerpt",
  "expect": "gate",
  "rationale": "Why this is the expected behavior.",
  "assertions": {
    "forbidden": ["sk-live-9f8a7b6c5d4e3f2a1b0c7d8e"],
    "required": ["[redacted-token]"]
  },
  "prompt": "Self-contained synthetic transcript priming the turn boundary..."
}
```

- `dimension` — `precision` | `recall` | `redaction` | `synthesis` (defaults to the folder name).
- `expect` — `gate` (sentinel must appear) | `silent` (sentinel must not appear).
- `assertions.forbidden` / `assertions.required` — optional; empty for plain
  precision/recall cases, populated for redaction.
- `assertions.rubric` — optional prose rubric (used by `synthesis` cases). When
  present and a gate was rendered, a second nested `claude` grades the gate's
  `Lesson:` against the rubric and must return `PASS`. Use it to assert qualities
  substrings can't — e.g. the lesson reads as a technical/code vs behavioral/flow
  defect, names the concrete problem, and says what correct looks like.
- `prompt` — primes the turn state in prose (what the hooks recorded, which
  skill/agent was active, the user's latest message) and instructs the model to
  apply the detector's full procedure at the turn boundary.

To add a scenario, drop a new JSON file in the appropriate dimension folder —
the runner discovers `scenarios/**/*.json` automatically.
