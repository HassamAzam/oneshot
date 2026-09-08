#!/usr/bin/env python3
"""Hook that flags model changes with no matching migration.

Wired to two triggers in .claude/settings.json:

- PreToolUse on the Skill tool, scoped (inside this script) to the
  code-review skills: erp-code-review, erp-review, erp-review-mr.
- SubagentStop on the backend-agent, so the check also runs right after
  backend-agent finishes making changes — not just when a review is
  explicitly requested.

Either way, this inspects the same diff scope a review would use —
uncommitted changes first, falling back to the current branch vs dev — and
checks whether any touched `apps/<app>/models.py` has no corresponding
change under `apps/<app>/migrations/`. Per backend-django.md: "any model,
field, constraint, relation, or schema change must include the migration in
the same MR."

Never blocks — it only injects additionalContext and a systemMessage so the
finding surfaces to the model/user.
"""

import json
import re
import subprocess
import sys

TARGET_SKILLS = {"erp-code-review", "erp-review", "erp-review-mr"}
TARGET_SUBAGENTS = {"backend-agent"}

MODEL_RE = re.compile(r"^apps/([^/]+)/models\.py$")
MIGRATION_RE = re.compile(r"^apps/([^/]+)/migrations/(?!__init__\.py$).+\.py$")


def get_changed_files() -> tuple[set[str], str | None]:
    """Return (changed_file_paths, scope_label) for the diff a review would cover."""
    status = subprocess.run(
        ["git", "status", "--porcelain"], capture_output=True, text=True, check=False
    ).stdout
    uncommitted = set()
    for line in status.splitlines():
        path = line[3:].split(" -> ")[-1].strip()
        if path:
            uncommitted.add(path)
    if uncommitted:
        return uncommitted, "uncommitted changes"

    for base_ref in ("origin/dev", "dev"):
        merge_base = subprocess.run(
            ["git", "merge-base", base_ref, "HEAD"],
            capture_output=True,
            text=True,
            check=False,
        )
        if merge_base.returncode != 0:
            continue
        diff = subprocess.run(
            ["git", "diff", "--name-only", merge_base.stdout.strip(), "HEAD"],
            capture_output=True,
            text=True,
            check=False,
        ).stdout
        diff_files = {f for f in diff.splitlines() if f}
        if diff_files:
            return diff_files, f"branch diff vs {base_ref}"

    return set(), None


def find_missing_migrations(changed_files: set[str]) -> list[str]:
    model_apps = set()
    migration_apps = set()
    for path in changed_files:
        model_match = MODEL_RE.match(path)
        if model_match:
            model_apps.add(model_match.group(1))
        migration_match = MIGRATION_RE.match(path)
        if migration_match:
            migration_apps.add(migration_match.group(1))
    return sorted(model_apps - migration_apps)


def should_run(payload: dict) -> bool:
    """Decide whether this invocation is one of the two wired triggers."""
    hook_event = payload.get("hook_event_name")
    if hook_event == "SubagentStop":
        return payload.get("agent_type") in TARGET_SUBAGENTS
    if payload.get("tool_name") == "Skill":
        skill_name = (payload.get("tool_input") or {}).get("skill")
        return skill_name in TARGET_SKILLS
    return False


def build_output(hook_event_name: str, missing_apps: list[str], context: str) -> dict:
    """Assemble the hook JSON response, PreToolUse-specific fields only when relevant."""
    output = {
        "systemMessage": (
            f"⚠️ Migration check: possible missing migration(s) for: "
            f"{', '.join(missing_apps)}"
        ),
        "hookSpecificOutput": {
            "hookEventName": hook_event_name,
            "additionalContext": context,
        },
    }
    if hook_event_name == "PreToolUse":
        output["hookSpecificOutput"]["permissionDecision"] = "allow"
        output["hookSpecificOutput"]["permissionDecisionReason"] = context
    return output


def main() -> None:
    try:
        payload = json.load(sys.stdin)
    except (json.JSONDecodeError, ValueError):
        sys.exit(0)

    if not should_run(payload):
        sys.exit(0)

    changed_files, scope = get_changed_files()
    if not scope:
        sys.exit(0)

    missing_apps = find_missing_migrations(changed_files)
    if not missing_apps:
        sys.exit(0)

    bullet_list = "\n".join(
        f"- apps/{app}/models.py changed but no migration found under "
        f"apps/{app}/migrations/ ({scope})"
        for app in missing_apps
    )
    context = (
        "MIGRATION CHECK — flag this:\n"
        f"{bullet_list}\n"
        "Per .claude/rules/backend-django.md, any model/field/constraint/relation "
        "change must include the migration in the same MR. Either this is "
        "intentional (no schema-affecting change) or `makemigrations` needs to "
        "be run before this MR is ready."
    )
    hook_event_name = payload.get("hook_event_name") or "PreToolUse"
    output = build_output(hook_event_name, missing_apps, context)
    print(json.dumps(output))
    sys.exit(0)


if __name__ == "__main__":
    main()
