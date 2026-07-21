---
description: Manually file loopback feedback about a skill/agent that produced a defect — synthesize a generalizable de-identified lesson, show the per-send consent gate, and submit only on explicit confirmation.
argument-hint: <artifact-id> <what the skill got wrong>
---

# /harness-feedback — manual loopback feedback

Canonical, harness-neutral command (installed by `npx @guidobuilds/loopback-setup` into
each harness's command directory). Use it when auto-detection missed a real defect, or
when the user explicitly wants to file feedback: "the prd-writer skill botched
this — file it." Runs the **same** flow as the feedback-detector skill and **never
sends anything without an explicit `[S]end`.**

User request: **$ARGUMENTS**

Do the following:

## 1. Identify the artifact

From `$ARGUMENTS`, determine the artifact id being reported (e.g. `prd-writer`), its
`kind` (`skill`|`agent`), and what it got wrong. If the artifact id is unclear, ask
the user for it before proceeding. These stamp `artifact.{id,kind,version}` on the
record. There is **no registry**: nothing is looked up and no owner is resolved. If the
loopback plugin injected a harness-surface inventory, prefer an artifact id from it —
it names a real installed skill/agent. Optionally, if the working directory is a git
repo, populate `artifact.repo` from `git remote get-url origin` (omit if unavailable).

## 2. Synthesize a generalizable lesson + redact the excerpt

Write the lesson as a **generalizable** statement (the `summary`), not a
file-specific note. Make it **clear, actionable, and self-typed**: a maintainer
must be able to read it and fix the skill, and tell from the wording alone whether
the defect is **technical / code** (name the concrete technical thing that was
wrong — out-of-scope file edits, wrong class/definition, missing typing, wrong
API/pattern, non-conforming structure — and what correct looks like) or
**behavioral / flow** (describe how the behavior was wrong — over-confirming,
skipped a promised step, ignored a standing convention, wrong sequencing — and the
correct behavior). There is no tag or separate field; the prose itself carries the
type. Reduce the evidence to a minimal excerpt and **redact it
yourself, in context, before showing or sending it** — replace emails →
`[redacted-email]`, secrets/tokens/keys → `[redacted-token]`, file paths and bare
source/doc filenames → `[redacted-path]`, and your username/`$HOME` →
`[redacted-user]`. The redacted text is exactly what is displayed and sent
(show-exactly-what-is-sent); never show or send the raw excerpt. Pick `severity`,
`confidence`, a `workType`, and a `clusterKey` of the form `artifact:workType:problem`.

## 3. Render the consent gate (verbatim)

Show the user EXACTLY this gate, filled in. The gate's first line is the sentinel
token `HFB-CONSENT-GATE-v1` on its own line — emit it ONLY when truly raising the
gate:

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

The pinned phrase **`send feedback to the owner?`** and the options **`[S]end`**,
**`[E]dit`**, **`[D]ecline`** must appear exactly as written.

## 4. Act on the user's choice

- **`[S]end`** → call **`submit_feedback`** (loopback MCP) with the artifact fields,
  the (possibly edited) `summary`, the redacted `evidenceExcerpt`, `workType`,
  `severity`, `confidence`, `clusterKey`, and the `harness` you are running under.
  On `status: "ok"` tell the user it was sent (mention the `id`); on
  `status: "quarantined"` re-redact the returned `patterns` and retry **once**; on
  `status: "error"` report it briefly.
- **`[E]dit`** → revise, **re-redact the edited excerpt in context**, re-render the
  gate, wait again.
- **`[D]ecline`** → send nothing, do not nag.

Never call `submit_feedback` without an explicit `[S]end`.
