#!/usr/bin/env python3
"""PreToolUse gate that enforces the mr-metadata skill on every MR create/update.

Triggered for:
    mcp__gitlab-mcp__create_merge_request
    mcp__gitlab-mcp__update_merge_request

Rejects (exit 2 + stderr fed back to the model) when:
    1. `title` carries a conventional-commit prefix (feat:/fix:/chore:/...).
    2. `description` lacks a `[closes https?://...]` line near the top.

For `update_merge_request`, only the fields actually present in `tool_input`
are validated; an update that doesn't touch title/description is allowed
through untouched.
"""

import json
import re
import sys

PREFIX_RE = re.compile(
    r"^(feat|fix|chore|refactor|test|docs|style|perf|ci|build|revert)"
    r"(\(.+?\))?!?:\s*",
    re.IGNORECASE,
)
CLOSES_RE = re.compile(r"\[closes\s+https?://\S+", re.IGNORECASE)

GUIDED_TOOLS = {
    "mcp__gitlab-mcp__create_merge_request",
    "mcp__gitlab-mcp__update_merge_request",
}

SKILL_HINT = (
    "Invoke the `mr-metadata` skill (`.claude/skills/mr-metadata/SKILL.md`) "
    "and apply its title + closes-link rules before retrying."
)


def _fail(reason: str) -> None:
    sys.stderr.write(f"[mr-metadata-gate] {reason}\n{SKILL_HINT}\n")
    sys.exit(2)


def main() -> None:
    try:
        payload = json.load(sys.stdin)
    except json.JSONDecodeError:
        sys.exit(0)

    tool_name = payload.get("tool_name", "")
    if tool_name not in GUIDED_TOOLS:
        sys.exit(0)

    tool_input = payload.get("tool_input") or {}
    title = tool_input.get("title")
    description = tool_input.get("description")

    is_create = tool_name.endswith("create_merge_request")

    if is_create:
        if not title:
            _fail("create_merge_request is missing `title`.")
        if description is None:
            _fail("create_merge_request is missing `description`.")

    if title is not None and PREFIX_RE.match(title):
        _fail(
            f"MR title still has a conventional-commit prefix: {title!r}. "
            "Strip the prefix and title-case the remainder."
        )

    if description is not None:
        head = "\n".join(description.splitlines()[:5])
        if not CLOSES_RE.search(head):
            _fail(
                "MR description is missing a `[closes <ticket_url>]` line in "
                "the first 5 lines. Add it at the very top of the description."
            )

    sys.exit(0)


if __name__ == "__main__":
    main()
