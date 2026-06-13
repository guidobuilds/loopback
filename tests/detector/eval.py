#!/usr/bin/env python3
"""Feedback-detector performance eval harness (scale runner + grader).

This is the model-driven evaluation suite for loopback's `feedback-detector`
skill. It drives the *real* skill — the very `SKILL.md` we ship — through a
corpus of synthetic turn-boundary scenarios and grades the model's output
against per-scenario assertions, so we can measure the skill's performance
along the dimensions that matter for it:

  precision  the skill must stay SILENT on normal iteration, scope changes,
             preference tweaks, ambiguous corrections, unattributable
             corrections, and Tier-2-only signals. A false positive trains
             the user to dismiss the gate, which is fatal to adoption — this
             is the skill's prime directive, so most of the corpus lives here.

  recall     the skill must RAISE the consent gate on a genuine, attributable
             defect (explicit correction, same-file revert, repeated
             re-instruction, repaired omission).

  redaction  on a real defect whose evidence contains PII / secrets / paths,
             the skill must raise the gate AND scrub the excerpt in-context
             before showing it (show-exactly-what-is-sent). We assert the raw
             secret never appears anywhere in the output and that the canonical
             [redacted-*] placeholders do.

  synthesis  on a real defect, the lesson the skill writes must be clear,
             actionable, and self-typed — a reader can tell from the wording
             alone whether it is a technical/code defect or a behavioral/flow
             defect, and knows what to change. Prose quality can't be checked by
             substring, so these scenarios carry an `assertions.rubric` graded by
             a second nested `claude` (see judge()).

How a scenario is driven
------------------------
Each scenario is a self-contained synthetic transcript that primes a turn
boundary and asks the model to apply the detector. We load the actual skill
into the nested `claude` via `--append-system-prompt "$(cat SKILL.md)"`, so the
suite tests the shipped skill text itself and does NOT depend on loopback being
installed (no MCP registration required): the scenarios stop at the consent-gate
render, and `submit_feedback` is only ever called on an explicit [S]end.

The consent-gate sentinel is the distinctive token the skill emits as the gate's
first line ONLY when the gate is truly rendered to the user:

    HFB-CONSENT-GATE-v1

Grading a scenario
------------------
A scenario PASSES iff all of:
  1. observed gate/silent == expected `expect`
  2. every `assertions.forbidden` substring is ABSENT from the output
     (e.g. a raw API key or email must never leak), and
  3. every `assertions.required` substring is PRESENT in the output
     (e.g. the `[redacted-token]` placeholder), and
  4. if `assertions.rubric` is set, the second-pass rubric judge returns PASS
     (only evaluated when a gate was rendered).

This suite is honest about its environment: if the nested-`claude` path is
unavailable or unreliable here, it exits 2 (ENV-UNAVAILABLE) and says so rather
than faking PASS.

Exit codes:
  0  every scenario matched its expectation (the contract holds)
  1  at least one scenario FAILED (a performance regression)
  2  the nested-claude path is unavailable in this environment (cannot judge)
"""

from __future__ import annotations

import argparse
import concurrent.futures
import json
import os
import shutil
import signal
import subprocess
import sys
import tempfile
import threading
import time
from pathlib import Path

MARKER = "HFB-CONSENT-GATE-v1"
# Verdict tokens the rubric judge (a second nested claude) must emit. Used only by
# `synthesis` scenarios that carry an `assertions.rubric`; see judge() below.
JUDGE_PASS = "JUDGE-VERDICT: PASS"
JUDGE_FAIL = "JUDGE-VERDICT: FAIL"
HERE = Path(__file__).resolve().parent
REPO = HERE.parent.parent
DEFAULT_SKILL = REPO / "loopback" / "skills" / "feedback-detector" / "SKILL.md"
DEFAULT_SCEN_DIR = HERE / "scenarios"
DIMENSIONS = ("precision", "recall", "redaction", "synthesis")


class Log:
    """Thread-safe, line-buffered progress logger.

    Each scenario runs a multi-second nested `claude`, so without streaming
    progress the suite looks frozen and a Ctrl-C leaves you with nothing. This
    prints a timestamped line (flushed immediately, even when stdout is piped)
    as each scenario starts and finishes, guarded by a lock so concurrent
    worker threads don't interleave mid-line.
    """

    def __init__(self):
        self._lock = threading.Lock()
        self._start = time.monotonic()

    def __call__(self, msg: str, err: bool = False) -> None:
        line = f"[+{time.monotonic() - self._start:6.1f}s] {msg}"
        with self._lock:
            print(line, file=sys.stderr if err else sys.stdout, flush=True)


def load_scenarios(scen_dir: Path, only_dim: str | None, only_id: str | None) -> list[dict]:
    scenarios = []
    for path in sorted(scen_dir.rglob("*.json")):
        try:
            data = json.loads(path.read_text())
        except json.JSONDecodeError as exc:
            sys.exit(f"FAIL: {path} is not valid JSON: {exc}")
        # Infer the dimension from the containing folder if not declared.
        data.setdefault("dimension", path.parent.name)
        data["_path"] = str(path)
        if only_dim and data["dimension"] != only_dim:
            continue
        if only_id and data.get("id") != only_id:
            continue
        scenarios.append(data)
    return scenarios


# Tools the nested session must not use. The scenarios are fully self-contained
# text — the model only has to read the primed turn state and reason. Letting it
# explore the filesystem or run git just distracts it from the scenario (and, in
# a dirty repo, it will latch onto the working-tree state instead of the task),
# so we deny the exploration/mutation tools and run each scenario in an isolated
# empty working directory.
DISALLOWED_TOOLS = [
    "Bash", "Read", "Glob", "Grep", "Edit", "Write",
    "WebFetch", "WebSearch", "Task", "NotebookEdit",
]


# Active nested-claude child processes, so a Ctrl-C can terminate them promptly.
# Each scenario blocks a worker thread inside the child; without killing the
# children, the interpreter would hang at exit joining those non-daemon threads
# and the partial summary would never flush. Tracking the Popens lets the
# interrupt handler unblock the workers cleanly.
_ACTIVE: set[subprocess.Popen] = set()
_ACTIVE_LOCK = threading.Lock()


def terminate_active() -> None:
    """Terminate every in-flight nested-claude child (best effort)."""
    with _ACTIVE_LOCK:
        procs = list(_ACTIVE)
    for p in procs:
        try:
            p.terminate()
        except Exception:
            pass


def drive(prompt: str, skill_text: str, model: str | None, timeout: int) -> tuple[str, float, bool]:
    """Run one prompt through a fresh nested `claude`. Returns (output, seconds, timed_out).

    When `skill_text` is non-empty it is appended as the system prompt (this is how
    the detector SKILL.md is loaded for scenario runs). Pass an empty string to run
    a plain nested `claude` with no skill attached — used by the rubric judge, which
    grades a lesson and must NOT itself behave like the detector.
    """
    cmd = ["claude", "-p", prompt]
    if skill_text:
        cmd += ["--append-system-prompt", skill_text]
    cmd += ["--disallowedTools", *DISALLOWED_TOOLS]
    if model:
        cmd += ["--model", model]
    # Isolate the nested run in a fresh empty cwd so it has no project CLAUDE.md,
    # git repo, or stray files to explore — only the self-contained scenario.
    workdir = tempfile.mkdtemp(prefix="detector-eval-")
    start = time.monotonic()
    proc = subprocess.Popen(
        cmd,
        cwd=workdir,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    with _ACTIVE_LOCK:
        _ACTIVE.add(proc)
    try:
        try:
            stdout, stderr = proc.communicate(timeout=timeout)
            timed_out = False
        except subprocess.TimeoutExpired:
            proc.kill()
            stdout, stderr = proc.communicate()
            timed_out = True
        return (stdout or "") + (stderr or ""), time.monotonic() - start, timed_out
    finally:
        with _ACTIVE_LOCK:
            _ACTIVE.discard(proc)
        shutil.rmtree(workdir, ignore_errors=True)


def judge(output: str, rubric: str, model: str | None, timeout: int) -> tuple[bool, str]:
    """Grade a rendered lesson against a prose `rubric` via a second nested `claude`.

    Substring checks can verify a placeholder is present, but they cannot tell
    whether a prose lesson is clear, actionable, and self-typed (does it read as a
    technical/code defect vs a behavioral/flow defect?). For `synthesis` scenarios
    we hand the gate output plus a rubric to a fresh nested `claude` and let it
    return a PASS/FAIL verdict. Returns (passed, reason).
    """
    prompt = (
        "You are grading the QUALITY of a synthesized feedback lesson — you are NOT "
        "writing one and NOT acting as a feedback detector.\n\n"
        "Below is (1) a rubric and (2) the consent-gate text a feedback skill "
        "produced. The lesson is on the `Lesson:` line of the gate. Judge ONLY "
        "whether that lesson satisfies EVERY point of the rubric.\n\n"
        f"=== RUBRIC ===\n{rubric}\n\n"
        f"=== GATE OUTPUT ===\n{output}\n\n"
        "On the FIRST line reply with EXACTLY one token — "
        f"`{JUDGE_PASS}` if every rubric point is met, otherwise `{JUDGE_FAIL}`. "
        "On the next line give a one-line reason."
    )
    out, _, timed_out = drive(prompt, "", model, min(timeout, 180))
    if timed_out:
        return False, "judge timed out"
    reason = next(
        (ln.strip() for ln in out.splitlines() if ln.strip() and "JUDGE-VERDICT" not in ln),
        "",
    )
    if JUDGE_PASS in out and JUDGE_FAIL not in out:
        return True, reason
    if JUDGE_FAIL in out:
        return False, reason or "rubric not met"
    return False, "judge produced no clear verdict"


def grade(scenario: dict, output: str, model: str | None = None, timeout: int = 300) -> dict:
    """Grade one scenario's output against expect + assertions.

    `model`/`timeout` are only used when a scenario carries `assertions.rubric`,
    which triggers the second-pass rubric judge (synthesis dimension). Scenarios
    without a rubric are graded purely on the deterministic checks below, exactly
    as before.
    """
    expect = scenario.get("expect")
    observed = "gate" if MARKER in output else "silent"
    expect_ok = observed == expect

    assertions = scenario.get("assertions", {}) or {}
    forbidden = assertions.get("forbidden", []) or []
    required = assertions.get("required", []) or []
    rubric = assertions.get("rubric")

    # `forbidden` substrings must NOT appear (raw secrets / PII leaked through).
    leaked = [s for s in forbidden if s in output]
    # `required` substrings MUST appear (e.g. canonical redaction placeholders).
    missing = [s for s in required if s not in output]

    checks = []
    checks.append({
        "text": f"output is '{expect}' (gate rendered={observed == 'gate'})",
        "passed": expect_ok,
        "evidence": f"sentinel {'present' if observed == 'gate' else 'absent'}; expected {expect}",
    })
    for s in forbidden:
        present = s in output
        checks.append({
            "text": f"raw value redacted (absent from output): {s!r}",
            "passed": not present,
            "evidence": "LEAKED into output" if present else "not present (good)",
        })
    for s in required:
        present = s in output
        checks.append({
            "text": f"redaction placeholder present: {s!r}",
            "passed": present,
            "evidence": "present (good)" if present else "MISSING",
        })

    # Optional rubric judge: only when a rubric is declared AND a gate was rendered
    # (no gate ⇒ no lesson to grade; expect_ok already fails that case).
    rubric_ok = None
    rubric_reason = ""
    if rubric and observed == "gate":
        rubric_ok, rubric_reason = judge(output, rubric, model, timeout)
        checks.append({
            "text": f"lesson satisfies rubric: {rubric}",
            "passed": rubric_ok,
            "evidence": rubric_reason or ("ok" if rubric_ok else "rubric not met"),
        })

    passed = expect_ok and not leaked and not missing and (rubric_ok is not False)
    return {
        "passed": passed,
        "expect": expect,
        "observed": observed,
        "leaked": leaked,
        "missing": missing,
        "rubric_ok": rubric_ok,
        "rubric_reason": rubric_reason,
        "checks": checks,
    }


def self_probe(skill_text: str, model: str | None, timeout: int) -> tuple[bool, str]:
    """Cheap deterministic probe: is nested `claude -p` usable here at all?"""
    token = "DETECTOR_EVAL_PROBE_OK"
    out, _, timed_out = drive(
        f"Reply with exactly the token {token} and nothing else.",
        skill_text,
        model,
        min(timeout, 120),
    )
    if timed_out:
        return False, "probe timed out"
    if token not in out:
        return False, "probe produced no usable output:\n" + "\n".join(out.splitlines()[:5])
    return True, ""


def short_flags(result: dict) -> str:
    flags = ""
    if result.get("timed_out"):
        flags += " [TIMEOUT]"
    if result.get("leaked"):
        flags += f" [LEAKED: {', '.join(result['leaked'])}]"
    if result.get("missing"):
        flags += f" [MISSING: {', '.join(result['missing'])}]"
    if result.get("rubric_ok") is False:
        flags += f" [RUBRIC: {result.get('rubric_reason') or 'failed'}]"
    return flags


def run_one(scenario: dict, skill_text: str, model: str, timeout: int,
            log: Log, counter: dict) -> dict:
    sid = scenario.get("id")
    dim = scenario.get("dimension")
    title = scenario.get("title", "")
    log(f"▶ start  [{sid:<7}] {dim:<9} {title}")
    out, seconds, timed_out = drive(scenario["prompt"], skill_text, model, timeout)
    result = grade(scenario, out, model, timeout)
    result.update({
        "id": sid,
        "dimension": dim,
        "title": title,
        "seconds": round(seconds, 1),
        "timed_out": timed_out,
        "output": out,
    })
    verdict = "PASS" if result["passed"] else "FAIL"
    with counter["lock"]:
        counter["done"] += 1
        k = counter["done"]
    log(f"✔ done   [{sid:<7}] {verdict} {result['seconds']:>5.1f}s  "
        f"({k}/{counter['total']}){short_flags(result)}")
    return result


def main() -> int:
    ap = argparse.ArgumentParser(description="Feedback-detector performance eval harness.")
    ap.add_argument("--skill", default=str(DEFAULT_SKILL), help="path to the feedback-detector SKILL.md")
    ap.add_argument("--scenarios-dir", default=str(DEFAULT_SCEN_DIR), help="directory of scenario JSON fixtures")
    ap.add_argument("--dimension", choices=DIMENSIONS, help="only run scenarios from this dimension")
    ap.add_argument("--id", help="only run the scenario with this id")
    ap.add_argument("--jobs", type=int, default=4, help="concurrent nested-claude runs (default 4)")
    ap.add_argument("--timeout", type=int, default=int(os.environ.get("SCENARIO_TIMEOUT", "300")),
                    help="per-scenario wall-clock budget in seconds (default 300)")
    ap.add_argument("--model", default=os.environ.get("EVAL_MODEL"), help="model id for the nested session")
    ap.add_argument("--json", dest="json_out", help="write the full grading report to this path")
    ap.add_argument("--save-outputs", dest="save_outputs", metavar="DIR",
                    help="write each scenario's full model output to DIR/<id>.txt (pass or fail)")
    ap.add_argument("--no-probe", action="store_true", help="skip the nested-claude self-probe")
    args = ap.parse_args()

    # Line-buffer stdout so the final table/aggregates aren't lost in a block
    # buffer when output is piped and the run is interrupted partway.
    try:
        sys.stdout.reconfigure(line_buffering=True)
    except Exception:
        pass

    skill_path = Path(args.skill)
    if not skill_path.is_file():
        print(f"FAIL: skill file not found: {skill_path}", file=sys.stderr)
        return 1
    skill_text = skill_path.read_text()

    scen_dir = Path(args.scenarios_dir)
    if not scen_dir.is_dir():
        print(f"FAIL: scenarios dir missing: {scen_dir}", file=sys.stderr)
        return 1

    if subprocess.run(["which", "claude"], capture_output=True).returncode != 0:
        print("ENV-UNAVAILABLE: 'claude' CLI not found on PATH; cannot drive the model-driven suite.",
              file=sys.stderr)
        return 2

    log = Log()

    scenarios = load_scenarios(scen_dir, args.dimension, args.id)
    if not scenarios:
        print("FAIL: no scenarios matched the given filters.", file=sys.stderr)
        return 1

    if not args.no_probe:
        log("probing nested `claude -p` ...")
        ok, why = self_probe(skill_text, args.model, args.timeout)
        if not ok:
            print(f"ENV-UNAVAILABLE: {why}", file=sys.stderr)
            print("  -> Run this suite where a nested `claude -p` executes (host/interactive session).",
                  file=sys.stderr)
            return 2
        log("probe ok")

    log(f"feedback-detector eval: {len(scenarios)} scenario(s), jobs={args.jobs}, "
        f"timeout={args.timeout}s")

    counter = {"done": 0, "total": len(scenarios), "lock": threading.Lock()}
    results: list[dict] = []

    # Ctrl-C handling: a blocked `as_completed` on the main thread won't deliver
    # a KeyboardInterrupt until a future finishes, so instead an explicit SIGINT
    # handler kills the in-flight children (unblocking their worker threads) and
    # sets a stop Event, while the main loop polls with a short timeout so it
    # notices the stop within ~0.5s regardless of when the next run completes.
    stop = threading.Event()

    def _on_sigint(_signum, _frame):
        if not stop.is_set():
            log("interrupt received — terminating in-flight scenarios and summarizing "
                "what finished ...", err=True)
            stop.set()
            terminate_active()

    prev_handler = signal.signal(signal.SIGINT, _on_sigint)

    pool = concurrent.futures.ThreadPoolExecutor(max_workers=max(1, args.jobs))
    futures = {
        pool.submit(run_one, s, skill_text, args.model, args.timeout, log, counter): s
        for s in scenarios
    }
    try:
        pending = set(futures)
        while pending:
            done, pending = concurrent.futures.wait(
                pending, timeout=0.5, return_when=concurrent.futures.FIRST_COMPLETED)
            for fut in done:
                try:
                    results.append(fut.result())
                except concurrent.futures.CancelledError:
                    pass
            if stop.is_set():
                for fut in pending:
                    fut.cancel()
                break
    finally:
        signal.signal(signal.SIGINT, prev_handler)
        pool.shutdown(wait=False, cancel_futures=True)

    interrupted = stop.is_set()

    if not results:
        log("no scenarios completed before interruption — nothing to report.", err=True)
        return 130 if interrupted else 1

    # Stable ordering for the report: by dimension, then id.
    results.sort(key=lambda r: (r["dimension"], str(r["id"])))

    # --- per-scenario table ---
    print()
    for r in results:
        verdict = "PASS" if r["passed"] else "FAIL"
        print(f"[{r['id']:<7}] {verdict:<4} {r['dimension']:<9} "
              f"expect={r['expect']:<6} observed={r['observed']:<6} "
              f"{r['seconds']:>5.1f}s  {r['title']}{short_flags(r)}")

    # --- per-dimension + overall aggregates ---
    print("\n" + "-" * 72)
    by_dim: dict[str, list[dict]] = {}
    for r in results:
        by_dim.setdefault(r["dimension"], []).append(r)
    summary = {}
    total_pass = 0
    for dim in sorted(by_dim):
        rs = by_dim[dim]
        p = sum(1 for r in rs if r["passed"])
        total_pass += p
        rate = p / len(rs)
        summary[dim] = {"passed": p, "total": len(rs), "pass_rate": round(rate, 3)}
        print(f"{dim:<10} {p}/{len(rs)} passed   (pass_rate={rate:.0%})")
    overall_rate = total_pass / len(results)
    label = "OVERALL" if not interrupted else "PARTIAL"
    print(f"{label:<10} {total_pass}/{len(results)} passed   (pass_rate={overall_rate:.0%})"
          + ("   [interrupted — not all scenarios ran]" if interrupted else ""))

    report = {
        "skill": str(skill_path),
        "model": args.model,
        "summary": {"overall": {"passed": total_pass, "total": len(results),
                                 "pass_rate": round(overall_rate, 3)},
                    "by_dimension": summary},
        "results": [{k: v for k, v in r.items() if k != "output"} for r in results],
    }
    if args.json_out:
        Path(args.json_out).write_text(json.dumps(report, indent=2))
        print(f"\nwrote grading report -> {args.json_out}")

    # Persist each scenario's full model output (the part the JSON report omits),
    # one file per id, so passing scenarios can be inspected too — not just the
    # 12-line failure tail printed below.
    if args.save_outputs:
        out_dir = Path(args.save_outputs)
        out_dir.mkdir(parents=True, exist_ok=True)
        for r in results:
            verdict = "PASS" if r["passed"] else "FAIL"
            header = (
                f"# [{r['id']}] {verdict}  dimension={r['dimension']}  "
                f"expect={r['expect']}  observed={r['observed']}  {r['seconds']}s\n"
                f"# {r['title']}\n"
                f"{'-' * 72}\n"
            )
            (out_dir / f"{r['id']}.txt").write_text(header + r.get("output", ""))
        print(f"wrote {len(results)} scenario output(s) -> {out_dir}")

    # Surface failing outputs for debugging.
    failures = [r for r in results if not r["passed"]]
    if failures:
        print("\n=== FAILURES (output tail) ===", file=sys.stderr)
        for r in failures:
            print(f"\n--- [{r['id']}] {r['title']} ---", file=sys.stderr)
            for line in r["output"].splitlines()[-12:]:
                print("    " + line, file=sys.stderr)

    if interrupted:
        return 130
    return 0 if not failures else 1


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        # A Ctrl-C outside the run loop (e.g. during the probe) still exits cleanly.
        print("\ninterrupted.", file=sys.stderr, flush=True)
        sys.exit(130)
