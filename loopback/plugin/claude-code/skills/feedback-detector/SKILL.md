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
and never send anything. **A harness MAY provide such a priming layer** — the
loopback Claude Code plugin ships hooks that inject a *harness-surface inventory*
(the installed skills/agents) and a *per-session write-log* (the files the agent
wrote). **When priming context is present, consume it** to strengthen Step 1's
same-file-revert signal and Step 3's attribution. **When it is absent** (OpenCode,
Codex, or Claude Code without the plugin) **detect the signals yourself** by reading
the visible conversation at the turn boundary — the skill behaves identically either
way. Either way the judgment and the consent exchange are exclusively your job, gated
on explicit user consent, and priming never decides a defect or sends anything.

The one side effect — sending a record — goes through the loopback MCP server's
**single tool, `submit_feedback`**, which is now **hosted by the loopback service**
(the harness connects to it as a *remote* MCP over HTTP). The skill is therefore
identical on every harness. Depending on the harness the tool may be surfaced with
a prefix (e.g. `mcp__loopback__submit_feedback` in Claude Code); call it by its
logical name and the harness will route it. Everything else — judging the defect,
synthesizing the lesson, and **redacting the excerpt** — is your own in-context
work (there is no `redact_preview`/`is_muted`/`session_state` tool anymore).

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
gates in Steps 1–4 still apply on every run — checking each turn does not mean
prompting each turn; it means staying silent unless a real defect clears every
gate. Never raise more than one candidate per artifact per session.

## Priming inputs (when present)

If the harness's loopback plugin is installed, two optional artifacts may be injected
into your context (as `additionalContext`) and mirrored locally under
`~/.loopback/state/<session>/`:

- **Harness-surface inventory** — the ids of installed skills and agents. Use it in
  Step 3 to attribute a correction to a **real, named** component ("you are correcting
  the `prd-writer` skill"). Naming a component that is **not** in the inventory is a
  red flag — prefer to drop.
- **Write-log** — the `file_path`s the agent wrote/edited this session. Use it in
  Step 1 (Signal 2) to recognize a same-file revert even when the original write has
  scrolled out of the visible transcript.

These are **corroborating input only**: they never raise a candidate by themselves and
never lower the precision bar — every gate below still applies. If no priming was
injected, ignore this section and self-detect from the conversation.

## Step 1 — Require at least one Tier-1 signal

Raise a candidate only if **>=1** of these high-precision signals is present:

1. **Explicit correction language** toward the agent's output — e.g. "no, that's
   wrong", "this isn't the right format", "you didn't test this", "the PRD
   template is X not Y", "always do…", "stop doing…".
2. **Same-`file_path` revert** — the agent wrote/edited file F this turn (the
   write-log recorded this, or it is visible in the turn) and the user reverts or
   rewrites that **same** file's region. Targeting the file the agent just wrote
   is the load-bearing signal. When a write-log is present it makes this signal
   deterministic even after the original write has scrolled out of context.
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

**If a harness-surface inventory was injected** (see *Priming inputs*), attribute to a
**named id from it** — that is the concrete way to tell the user they are correcting a
real harness component. Attributing to an id **absent** from the inventory is a red
flag: prefer to drop. **If no inventory was injected**, identify the producer from the
visible conversation exactly as before.

- An active skill/agent can be identified → attributable; keep `artifact.{id,kind,version}`.
- **No** skill/agent can be identified at all → **drop the candidate silently.** An
  unattributable correction cannot be tied to a producer and is not worth
  interrupting the user for (precision bias).

Optionally, if the current working directory is a git repo, you may populate
`artifact.repo` from `git remote get-url origin` (the repo where the user was
working). This field is optional — omit it and do not hard-fail if it is
unavailable.

## Step 4 — De-bounce (one candidate per artifact per session)

Raise **one candidate per artifact per session.** Check your own conversation
context: if you have already surfaced a candidate for this artifact this session
(or the user already declined or sent one), do **not** prompt again — fold any new
evidence into `severity` instead. (Per-machine muting — the old "Never for this
skill" opt-out — is not available in this version.)

## Step 5 — Synthesize a generalizable lesson + redact the excerpt

Write a **generalizable** lesson (the `summary`), not a file-specific note:
- Bad: "in this file you used the wrong header."
- Good: "PRDs from `prd-writer` should use the `## Problem / ## Solution /
  ## Metrics` template; the generated PRD used a freeform structure."

**Make the lesson clear, actionable, and self-typed.** A person must be able to
read the `summary` and change the skill so it stops doing this — so the lesson has
to (a) make the **nature of the defect evident from its wording alone** (no label
and no separate field; the prose itself carries the type), and (b) state
concretely what went wrong **and** what correct looks like, at the level of a
skill instruction. There are two shapes today, and the taxonomy is open — if a
defect fits neither, describe its nature with the same concreteness:

- **Technical / code defect** — the implementation or technical compliance was
  wrong. Name the concrete technical thing that failed: e.g. edited files outside
  the requested scope, wrong class/definition, missing type annotations, wrong
  API or pattern, non-conforming structure/format — then say what it should be.
  - Bad (vague): "the migration was wrong."
  - Good (technical, actionable): "`db-migrator` produced an irreversible
    migration (a `DROP TABLE` to add a column); migrations must be reversible —
    use `ALTER TABLE ADD COLUMN` so the change can be rolled back."
- **Behavioral / flow defect** — the process or behavior was wrong, even if the
  produced content was fine. Describe **how** the behavior was wrong: e.g. asked
  for confirmation before every step, skipped a step it had promised, ignored a
  standing convention, wrong sequencing — then say what the correct behavior is.
  - Bad (vague): "it behaved wrong."
  - Good (behavioral, actionable): "`commit-writer` asked for confirmation before
    every individual file edit; the user expects it to make the planned edits in
    one pass and confirm once at the end, not gate every step."

A reader should be able to tell which kind of defect it is from the description
alone, without any tag. Keep the lesson generalizable and de-identified.

Reduce the raw correction to a **minimal** evidence excerpt and **redact it
yourself, in context, before you show or send it.** Replace, at minimum:
- email addresses → `[redacted-email]`
- secrets / tokens / keys (API keys, GitHub/AWS/Slack tokens, JWTs, `Bearer`
  tokens, `BEGIN … PRIVATE KEY` blocks) → `[redacted-token]`
- absolute or relative filesystem paths and bare source/doc file names
  (e.g. `/Users/you/app/auth.ts`, `auth.ts`, `prd.md`) → `[redacted-path]`
- your OS username / `$HOME` → `[redacted-user]`

Keep the excerpt short (a few lines, ~600 characters max). The redacted text you
produce is **exactly** what you will display and send (show-exactly-what-is-sent);
never show or send the raw excerpt. The service re-checks redaction on receipt as
a safety net (Step 7), but do not lean on it — redact thoroughly here.

Rate `severity` (low|medium|high) and your own `confidence` (low|medium|high), and
propose a `clusterKey` of the form `artifact:workType:problem`
(e.g. `prd-writer:prd-authoring:wrong-template`).

## Step 6 — Render the consent gate (verbatim format)

Show the user EXACTLY this gate, filled in with the identified artifact, the
synthesized lesson, and the excerpt you redacted in Step 5. The excerpt shown is
byte-for-byte what is sent.

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

  [S]end   [E]dit lesson/excerpt   [D]ecline
```

The pinned phrase **`send feedback to the owner?`** and the literal options
**`[S]end`**, **`[E]dit`**, and **`[D]ecline`** must appear exactly as written so
the gate is unambiguous and testable.

**Sentinel discipline (do not leak the token):** whenever you do **not** raise the
gate — iteration, unattributable drop, declined, de-bounced, or any other silent
drop — you MUST NOT output the `HFB-CONSENT-GATE-v1` token or any part of the gate
template. You may briefly note that you are not sending feedback, but never
reproduce or quote the sentinel (or the gate block) except when you are truly
rendering the gate to the user in this step.

## Step 7 — Act ONLY on the user's choice

- **`[S]end`** → call the **`submit_feedback`** tool with the artifact fields
  (`artifactKind`, `artifactId`, and `artifactVersion`/`artifactRepo` if known),
  the (possibly user-edited) `summary`, the redacted `evidenceExcerpt`, `workType`,
  `severity`, `confidence`, `clusterKey`, and the `harness` you are running under.
  Then read the returned `status`:
  - `"ok"` → the record was stored; tell the user it was sent (you may mention the
    returned `id`).
  - `"quarantined"` → the service's redaction safety net found PII/secret
    `patterns` you missed. Re-redact **those specific patterns** out of the
    `summary`/`evidenceExcerpt` and call `submit_feedback` **once** more. If it is
    still quarantined, tell the user it could not be sent safely and stop — do not
    keep retrying.
  - `"error"` → report the error briefly; nothing was stored.
- **`[E]dit`** → let the user correct the lesson and/or trim/expand the excerpt,
  **re-redact the edited excerpt in context** (Step 5), re-render this gate, and
  wait again.
- **`[D]ecline`** → do nothing, send nothing, and do not nag. Decline is free and
  silent.

Never call `submit_feedback` without an explicit `[S]end`. Nothing leaves the
machine without per-send consent.

See `reference.md` for the full signal taxonomy and worked defect-vs-iteration
examples.
