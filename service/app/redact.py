"""Server-side redaction re-check (design §7, defense in depth).

The client redacts before display/send (show-exactly-what-is-sent). The service
re-runs the same class of detectors so a buggy or malicious client cannot leak
PII/secrets into the central store. Records that still contain PII/secret
patterns are QUARANTINED (HTTP 422), never written to the main ``records`` table.

This module deliberately mirrors the client-side pattern set (plugin A5). It is
detection-only here: the contract is that a clean payload passes unchanged; a
dirty payload is rejected, not silently scrubbed (the user already approved the
exact bytes, so the server's job is to catch leaks, not to mutate consented
content).
"""
from __future__ import annotations

import re
from typing import List

# Each pattern is (name, compiled regex). Order is not significant.
#
# Path detection mirrors the client redactor (plugin A5): only GENUINELY path-like
# tokens count, never ordinary "/"-delimited prose ("Problem/Solution/Metrics",
# "TCP/IP", "and/or"). A token is path-like only when it is rooted in a known
# absolute root, anchored at a token boundary (/, ~/, ./, ../, C:\, \\share), or
# is a slashed token whose basename has a code/doc file extension.
_FILE_EXT = (
    r"ts|tsx|js|jsx|mjs|cjs|py|rb|go|rs|java|kt|c|cc|cpp|h|hpp|cs|php|swift|"
    r"md|json|yaml|yml|toml|ini|env|txt|sql|sh|html|css|scss"
)
_PATTERNS = [
    # Emails: user@host.tld
    ("email", re.compile(r"[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}")),
    # Rooted absolute POSIX paths under a known system root.
    (
        "posix_user_path",
        re.compile(r"/(?:Users|home|var|tmp|etc|opt|private)/[^\s\"'`<>|]+"),
    ),
    # Anchored POSIX paths at a token boundary: leading /, ~/, ./, ../
    (
        "posix_anchored_path",
        re.compile(r"(?:^|(?<=[\s\"'`(<\[{]))(?:~/|\.{1,2}/|/)[^\s\"'`<>|]+"),
    ),
    # Slashed token whose basename carries a code/doc extension (a/b/c.py).
    (
        "extension_path",
        re.compile(
            r"\b[\w.~-]+(?:/[\w.~-]+)+\.(?:" + _FILE_EXT + r")\b",
            re.IGNORECASE,
        ),
    ),
    # Windows paths (drive-letter or UNC share).
    (
        "windows_user_path",
        re.compile(r"(?:[A-Za-z]:\\|\\\\)[^\s\"'`<>|]+"),
    ),
    # GitHub personal access tokens
    ("github_token", re.compile(r"gh[pousr]_[A-Za-z0-9]{16,}")),
    # AWS access key ids
    ("aws_key", re.compile(r"AKIA[0-9A-Z]{16}")),
    # OpenAI-style secret keys
    ("openai_key", re.compile(r"sk-[A-Za-z0-9]{16,}")),
    # Slack tokens
    ("slack_token", re.compile(r"xox[baprs]-[A-Za-z0-9\-]{10,}")),
    # Generic bearer / api key assignments
    ("bearer", re.compile(r"(?i)bearer\s+[A-Za-z0-9._\-]{16,}")),
    # Private key blocks
    ("private_key", re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----")),
]


def find_leaks(text: str | None) -> List[str]:
    """Return the names of any PII/secret patterns present in ``text``."""
    if not text:
        return []
    hits: List[str] = []
    for name, pat in _PATTERNS:
        if pat.search(text):
            hits.append(name)
    return hits


def has_leak(*texts: str | None) -> bool:
    """True if any of the given text fields still contains a PII/secret pattern."""
    return any(find_leaks(t) for t in texts)


def leak_reasons(*texts: str | None) -> List[str]:
    """Aggregate, de-duplicated list of leak pattern names across fields."""
    seen: List[str] = []
    for t in texts:
        for name in find_leaks(t):
            if name not in seen:
                seen.append(name)
    return seen
