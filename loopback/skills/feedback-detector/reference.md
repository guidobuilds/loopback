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

## Gates recap (run in order, stop at the first that fails)

1. **>=1 Tier-1 signal?** No → silent.
2. **Defect (not iteration)?** Iteration/ambiguous → silent.
3. **Attributable?** No active skill/agent can be identified as the producer → silent.
4. **Not muted?** the `is_muted` tool returns `muted: true` → silent.
5. **Not already raised for this artifact this session?** Already raised → fold into
   severity, do not re-prompt.

Only a candidate that clears all five reaches the consent gate.

## Privacy invariants

- The redacted excerpt shown in the gate is **byte-for-byte** what is sent
  (show-exactly-what-is-sent).
- `submit_feedback` re-redacts defensively, so even an edited excerpt is cleaned
  again before transmission.
- No client-side user identifier is carried on the wire; the submitter is
  resolved server-side from the auth token (`records.user_id`), and no PII ever
  leaves the machine.
