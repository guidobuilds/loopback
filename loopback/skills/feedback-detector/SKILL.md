---
name: feedback-detector
description: Evaluate at the END OF EVERY TURN whether the user just corrected, rejected, reverted, or re-instructed output that a shipped skill or subagent produced — e.g. they say it's wrong / not the right format / "you forgot to test", they rewrite or revert a file you generated earlier this session, or they repeat the same correction about one artifact. Do this self-check yourself by reading the visible conversation; no external hook or tripwire is required to fire. Applies a hard precision filter (real skill/agent DEFECT vs. normal iteration), and only on a genuine defect synthesizes a generalizable de-identified lesson and runs a per-send consent gate to forward feedback to that skill's owner ONLY on explicit user confirmation. Stay silent for new requirements, scope changes, preference tweaks, or edits that can't be attributed to a skill/agent.
---

# Feedback Detector

You are the judgment + synthesis + consent layer of loopback (design §3, §4).
loopback is harness-agnostic: it runs the same way under Claude Code, OpenCode,
and Codex. **You** do the detection, the reasoning, the synthesis, and the
consent exchange. If a harness happens to provide deterministic tripwires
(hooks/plugin) they only *prime* context — they never decide a defect occurred
and never send anything. **No tripwire is wired today (the default), so do not
wait for one:** detect the signals yourself by reading the visible conversation
at the turn boundary. Either way the judgment and the consent exchange are
exclusively your job, gated on explicit user consent.

All state and side effects go through the **loopback MCP server's tools**, so this
skill is identical on every harness (no harness-specific file paths). Depending on
the harness those tools may be surfaced with a prefix (e.g.
`mcp__loopback__submit_feedback` in Claude Code); call them by their logical name
below and the harness will route them.

## Prime directive: bias HARD for precision over recall

A false positive interrupts the user and trains them to dismiss the prompt, which
is fatal to adoption. **It is far better to miss a real defect than to raise a
false one.** When in doubt, stay silent. Never raise more than one candidate per
artifact per session.

## When to run

Self-evaluate at **every natural turn boundary** — the moment the user sends a
message reacting to your previous output, before you start executing their next
request. **You do not need a tripwire or hook to fire**; read the visible
conversation yourself and check for the Step 1 signals. Run when any of these is
true:

- the latest user message contains **correction language** about something a
  shipped skill/agent produced ("no, that's wrong", "wrong format", "you didn't
  test this", "the template is X not Y"), or
- the user **reverts or rewrites a file** you wrote earlier this session, or
- the user **repeats a correction** about the same artifact, or
- the user explicitly asks to file feedback (the manual feedback command).

Never run mid-task, and run the check **at most once per turn**. The precision
gates in Steps 1–5 still apply on every run — checking each turn does not mean
prompting each turn; it means staying silent unless a real defect clears every
gate. Never raise more than one candidate per artifact per session.

## Step 1 — Require at least one Tier-1 signal

Raise a candidate only if **>=1** of these high-precision signals is present:

1. **Explicit correction language** toward the agent's output — e.g. "no, that's
   wrong", "this isn't the right format", "you didn't test this", "the PRD
   template is X not Y", "always do…", "stop doing…".
2. **Same-`file_path` revert** — the agent wrote/edited file F this turn (a
   tripwire primed this, or it is visible in the turn) and the user reverts or
   rewrites that **same** file's region. Targeting the file the agent just wrote
   is the load-bearing signal.
3. **Repeated re-instruction** — **>=2** corrective prompts about the same
   artifact/task within a short window (the user is fighting the skill).

Tier-2 signals (a skill was active; negative sentiment without a concrete
correction; a test failure then a manual fix) are **corroborating only** and are
**never sufficient alone**. If you have only Tier-2 signals, stay silent.

## Step 2 — Defect-vs-iteration filter (decline when ambiguous)

- Adding a **new requirement** ("now also add pagination", "also handle the empty
  case") is **iteration, not a defect** → **decline silently**, no candidate.
- **Contradicting or repairing** what the skill already did ("that's the wrong
  format", "you forgot to test", "the template is Problem/Solution/Metrics, not
  freeform") is a **defect** → proceed.
- If you cannot clearly tell which it is, treat it as iteration and **decline**.

## Step 3 — Attribution gate (drop if no artifact can be identified)

Identify **which** shipped skill/agent produced the corrected output. Capture its
`id`, `kind` (`skill`|`agent`), and `version` if known — these stamp
`artifact.{id,kind,version}` on the record so the stored feedback is identifiable.
There is **no registry**: nothing is looked up and no owner is resolved.

- An active skill/agent can be identified → attributable; keep `artifact.{id,kind,version}`.
- **No** skill/agent can be identified at all → **drop the candidate silently.** An
  unattributable correction cannot be tied to a producer and is not worth
  interrupting the user for (precision bias).

Optionally, if the current working directory is a git repo, you may populate
`artifact.repo` from `git remote get-url origin` (the repo where the user was
working). This field is optional — omit it and do not hard-fail if it is
unavailable.

## Step 4 — Mute gate (respect local opt-out)

Call the **`is_muted`** tool with the artifact id.

- `muted: true` → the user chose "Never for this skill" on this machine → **stay silent.**
- `muted: false` → continue.

## Step 5 — De-bounce

Raise **one candidate per artifact per session**. Call **`get_session_state`** and
check `raised`: if it already lists this artifact (you surfaced, or the user
declined/sent, a candidate for it this session), fold the new evidence into
severity but do **not** prompt again.

## Step 6 — Synthesize a generalizable lesson + redacted excerpt

Write a **generalizable** lesson (the `summary`), not a file-specific note:
- Bad: "in this file you used the wrong header."
- Good: "PRDs from `prd-writer` should use the `## Problem / ## Solution /
  ## Metrics` template; the generated PRD used a freeform structure."

Reduce the raw correction to a **minimal** evidence excerpt and redact it by
calling the **`redact_preview`** tool. The `redacted` text it returns is exactly
what will be displayed and sent (show-exactly-what-is-sent); never show or send
the raw excerpt.

Rate `severity` (low|medium|high) and your own `confidence` (low|medium|high), and
propose a `clusterKey` of the form `artifact:workType:problem`
(e.g. `prd-writer:prd-authoring:wrong-template`).

## Step 7 — Render the consent gate (verbatim format)

Show the user EXACTLY this gate, filled in with the identified artifact, the
synthesized lesson, and the `redacted` excerpt from `redact_preview`. The excerpt
shown is byte-for-byte what is sent.

The gate's first line is the sentinel token `HFB-CONSENT-GATE-v1` on its own
line. This sentinel is the machine-detectable proof that the gate was actually
rendered to the user; emit it **only** here, when truly raising the gate.

```
HFB-CONSENT-GATE-v1
Possible skill defect detected — send feedback to the owner?

  Skill:    <artifact-id>  (<version>)
  Lesson:   <synthesized generalizable lesson>
  Evidence (redacted, this is exactly what is sent):
            "<redacted excerpt>"   (your file paths and names removed)
  Severity: <low|medium|high>     Confidence: <low|medium|high>

  [S]end   [E]dit lesson/excerpt   [D]ecline   [N]ever for this skill
```

The pinned phrase **`send feedback to the owner?`** and the literal options
**`[S]end`**, **`[E]dit`**, **`[D]ecline`**, and **`[N]ever`** must appear exactly
as written so the gate is unambiguous and testable.

**Sentinel discipline (do not leak the token):** whenever you do **not** raise the
gate — iteration, unattributable drop, muted, declined, de-bounced, or any other
silent drop — you MUST NOT output the `HFB-CONSENT-GATE-v1` token or any part of
the gate template. You may briefly note that you are not sending feedback, but
never reproduce or quote the sentinel (or the gate block) except when you are
truly rendering the gate to the user in this step.

## Step 8 — Act ONLY on the user's choice

- **`[S]end`** → call the **`submit_feedback`** tool with the artifact fields, the
  (possibly user-edited) `summary`, the redacted `evidenceExcerpt`, `workType`,
  `severity`, `confidence`, and `clusterKey`. The tool re-redacts defensively,
  validates against the wire contract, stamps `client.{plugin,harness}`, and
  POSTs. Report the returned `issueUrl` to the user.
- **`[E]dit`** → let the user correct the lesson and/or trim/expand the excerpt,
  **re-run `redact_preview` on the edited excerpt**, re-render this gate, and wait again.
- **`[D]ecline`** → do nothing, send nothing, and do not nag. Decline is free and
  silent.
- **`[N]ever`** → call the **`mute_artifact`** tool with the artifact id to mute it
  on this machine, then send nothing.

Never call `submit_feedback` without an explicit `[S]end`. Nothing leaves the
machine without per-send consent.

See `reference.md` for the full signal taxonomy and worked defect-vs-iteration
examples.
