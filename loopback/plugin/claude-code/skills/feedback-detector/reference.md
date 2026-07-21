# Feedback Detector — signal taxonomy & worked examples

Companion reference for `SKILL.md` (design §3). Load when you need the detailed
signal definitions or borderline defect-vs-iteration calls.

## Signal tiers

### Tier-1 (high precision — any one can raise a candidate)

| Signal | What it looks like | Why it is high-precision |
|--------|--------------------|--------------------------|
| Explicit correction language | "no, that's wrong", "wrong format", "you didn't test this", "the template is X not Y", "always/stop doing…" | The user is explicitly repairing the agent's output. |
| Same-`file_path` revert | the agent writes/edits F this turn; user reverts/rewrites that same F | Targeting the just-written file is unambiguous repair, not new work. |
| Repeated re-instruction | >=2 corrective prompts about the same artifact in a short window | The user is fighting the skill, not iterating forward. |

### Tier-2 (corroborating only — never sufficient alone)

- A skill/agent was active this turn (makes attribution possible).
- Negative sentiment without a concrete correction ("ugh, this is bad").
- A validation/test failure right after skill output, then a manual fix.

Tier-2 may *raise confidence* on a Tier-1 candidate but can never raise a
candidate by itself.

### Priming inputs (when the plugin is installed)

The loopback Claude Code plugin may inject two corroborating artifacts at the turn
boundary (and mirror them under `~/.loopback/state/<session>/`):

- a **harness-surface inventory** (installed skill/agent ids) — corroborates the
  Tier-2 "a skill/agent was active" signal and lets Step 3 attribute to a real, named
  id; it is **never sufficient alone** to raise a candidate.
- a **write-log** (files written this session) — makes the Tier-1 same-file-revert
  signal deterministic even after transcript truncation.

Priming never raises a candidate by itself and never relaxes the four gates. When it is
absent, self-detect from the visible conversation exactly as documented here.

## Defect vs. iteration — worked examples

| User prompt after the agent's output | Verdict | Reason |
|-----------------------------------|---------|--------|
| "no, the PRD template is Problem/Solution/Metrics, not freeform" | **defect** | Contradicts/repairs the format the skill produced. |
| (reverts `auth.ts` the agent just wrote, restoring the prior logic) | **defect** | Same-file revert of just-written output. |
| "now also add pagination to the endpoint" | **iteration** | New requirement, not a repair. Decline. |
| "also handle the empty-list case" | **iteration** | Additive scope. Decline. |
| "you forgot to write the tests you said you'd write" | **defect** | Repairs an omission in the skill's own output. |
| "make it blue instead of green" (pure preference, nothing was 'wrong') | **iteration** | Preference change, not a defect. Decline. |
| ambiguous / can't tell | **iteration** | When unsure, decline (precision bias). |

## Writing the lesson: make the defect type evident and actionable

Once a defect clears the gates, write the `summary` so a maintainer can read it and
fix the skill — and so the **kind** of defect is obvious from the wording alone (no
tag, no separate field; the prose carries the type). Two shapes today; the taxonomy
is open.

| Defect type | What the description must capture | Example phrasing |
|-------------|-----------------------------------|------------------|
| **Technical / code** | The concrete technical thing that was wrong — out-of-scope file edits, wrong class/definition, missing typing, wrong API/pattern, non-conforming structure/format — **and** what correct looks like, at the level of a skill instruction. | "the PRD was freeform; the template must be `## Problem / ## Solution / ## Metrics`." · "the migration used `DROP TABLE` to add a column; migrations must be reversible — use `ALTER TABLE ADD COLUMN`." |
| **Behavioral / flow** | **How** the process/behavior was wrong — over-confirming, skipped a promised step, ignored a standing convention, wrong sequencing — **and** the correct behavior. | "the skill stopped to confirm before every individual edit; make the planned edits in one pass and confirm once at the end." · "the skill skipped the tests it said it would write; when it commits to a step in its plan it must actually complete it." |

The technical/behavioral split is **not stored anywhere** — it lives only in how the
`summary` reads. A good lesson is self-typing: a person can tell which it is, and
knows what to change, without any label.

Pointers in the eval corpus: REC-01 (wrong PRD template) and REC-08 (irreversible
migration) read as **technical**; REC-03 (skipped the promised tests) and REC-05
(ignored the docstring "house convention") read as **behavioral**.

**Adding a new type:** there is no schema to touch — add a row to this table and a
bad/good example to SKILL.md Step 5, and the detector will write that shape too.

## Gates recap (run in order, stop at the first that fails)

1. **>=1 Tier-1 signal?** No → silent.
2. **Defect (not iteration)?** Iteration/ambiguous → silent.
3. **Attributable?** No active skill/agent can be identified as the producer → silent.
4. **Not already raised for this artifact this session?** Already raised → fold into
   severity, do not re-prompt.

Only a candidate that clears all four reaches the consent gate.

## Privacy invariants

- The excerpt you redact **in context** and show in the gate is **byte-for-byte**
  what is sent (show-exactly-what-is-sent); the raw excerpt never leaves the machine.
- The service re-checks redaction on receipt as a safety net: if a PII/secret
  pattern slipped through, the record is **quarantined** (not stored) and
  `submit_feedback` returns `status: "quarantined"` with the offending `patterns`
  so you can re-redact and retry once.
- No client-side user identifier is carried on the wire; the submitter is resolved
  server-side from the auth token (`records.user_id`), and no PII ever leaves the
  machine.
