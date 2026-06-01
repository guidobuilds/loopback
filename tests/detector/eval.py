#!/usr/bin/env python3
"""Feedback-detector performance eval harness (scale runner + grader).

This is the model-driven evaluation suite for loopback's `feedback-detector`
skill. It drives the *real* skill — the very `SKILL.md` we ship — through a
corpus of synthetic turn-boundary scenarios and grades the model's output
against per-scenario assertions, so we can measure the skill's performance
along the three dimensions that matter for it:

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
     (e.g. the `[redacted-token]` placeholder).

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
import subprocess
import sys
import tempfile
import time
from pathlib import Path

MARKER = "HFB-CONSENT-GATE-v1"
HERE = Path(__file__).resolve().parent
REPO = HERE.parent.parent
DEFAULT_SKILL = REPO / "loopback" / "skills" / "feedback-detector" / "SKILL.md"
DEFAULT_SCEN_DIR = HERE / "scenarios"
DIMENSIONS = ("precision", "recall", "redaction")


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


def drive(prompt: str, skill_text: str, model: str | None, timeout: int) -> tuple[str, float, bool]:
    """Run one prompt through the nested skill. Returns (output, seconds, timed_out)."""
    cmd = ["claude", "-p", prompt, "--append-system-prompt", skill_text,
           "--disallowedTools", *DISALLOWED_TOOLS]
    if model:
        cmd += ["--model", model]
    # Isolate the nested run in a fresh empty cwd so it has no project CLAUDE.md,
    # git repo, or stray files to explore — only the self-contained scenario.
    workdir = tempfile.mkdtemp(prefix="detector-eval-")
    start = time.monotonic()
    try:
        proc = subprocess.run(
            cmd,
            cwd=workdir,
            stdin=subprocess.DEVNULL,
            capture_output=True,
            text=True,
            timeout=timeout,
        )
        out = (proc.stdout or "") + (proc.stderr or "")
        return out, time.monotonic() - start, False
    except subprocess.TimeoutExpired as exc:
        out = ""
        if exc.stdout:
            out += exc.stdout if isinstance(exc.stdout, str) else exc.stdout.decode(errors="replace")
        if exc.stderr:
            out += exc.stderr if isinstance(exc.stderr, str) else exc.stderr.decode(errors="replace")
        return out, time.monotonic() - start, True
    finally:
        shutil.rmtree(workdir, ignore_errors=True)


def grade(scenario: dict, output: str) -> dict:
    """Grade one scenario's output against expect + assertions."""
    expect = scenario.get("expect")
    observed = "gate" if MARKER in output else "silent"
    expect_ok = observed == expect

    assertions = scenario.get("assertions", {}) or {}
    forbidden = assertions.get("forbidden", []) or []
    required = assertions.get("required", []) or []

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

    passed = expect_ok and not leaked and not missing
    return {
        "passed": passed,
        "expect": expect,
        "observed": observed,
        "leaked": leaked,
        "missing": missing,
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


def run_one(scenario: dict, skill_text: str, model: str, timeout: int) -> dict:
    out, seconds, timed_out = drive(scenario["prompt"], skill_text, model, timeout)
    result = grade(scenario, out)
    result.update({
        "id": scenario.get("id"),
        "dimension": scenario.get("dimension"),
        "title": scenario.get("title", ""),
        "seconds": round(seconds, 1),
        "timed_out": timed_out,
        "output": out,
    })
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
    ap.add_argument("--no-probe", action="store_true", help="skip the nested-claude self-probe")
    args = ap.parse_args()

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

    scenarios = load_scenarios(scen_dir, args.dimension, args.id)
    if not scenarios:
        print("FAIL: no scenarios matched the given filters.", file=sys.stderr)
        return 1

    if not args.no_probe:
        ok, why = self_probe(skill_text, args.model, args.timeout)
        if not ok:
            print(f"ENV-UNAVAILABLE: {why}", file=sys.stderr)
            print("  -> Run this suite where a nested `claude -p` executes (host/interactive session).",
                  file=sys.stderr)
            return 2

    print(f"feedback-detector eval: {len(scenarios)} scenario(s), jobs={args.jobs}, "
          f"timeout={args.timeout}s\n")

    results: list[dict] = []
    with concurrent.futures.ThreadPoolExecutor(max_workers=max(1, args.jobs)) as pool:
        futures = {
            pool.submit(run_one, s, skill_text, args.model, args.timeout): s for s in scenarios
        }
        for fut in concurrent.futures.as_completed(futures):
            results.append(fut.result())

    # Stable ordering for the report: by dimension, then id.
    results.sort(key=lambda r: (r["dimension"], str(r["id"])))

    # --- per-scenario table ---
    for r in results:
        verdict = "PASS" if r["passed"] else "FAIL"
        flags = ""
        if r["timed_out"]:
            flags += " [TIMEOUT]"
        if r["leaked"]:
            flags += f" [LEAKED: {', '.join(r['leaked'])}]"
        if r["missing"]:
            flags += f" [MISSING: {', '.join(r['missing'])}]"
        print(f"[{r['id']:<7}] {verdict:<4} {r['dimension']:<9} "
              f"expect={r['expect']:<6} observed={r['observed']:<6} "
              f"{r['seconds']:>5.1f}s  {r['title']}{flags}")

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
    print(f"{'OVERALL':<10} {total_pass}/{len(results)} passed   (pass_rate={overall_rate:.0%})")

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

    # Surface failing outputs for debugging.
    failures = [r for r in results if not r["passed"]]
    if failures:
        print("\n=== FAILURES (output tail) ===", file=sys.stderr)
        for r in failures:
            print(f"\n--- [{r['id']}] {r['title']} ---", file=sys.stderr)
            for line in r["output"].splitlines()[-12:]:
                print("    " + line, file=sys.stderr)

    return 0 if not failures else 1


if __name__ == "__main__":
    sys.exit(main())
