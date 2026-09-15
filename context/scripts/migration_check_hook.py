#!/usr/bin/env python3
"""Migration-hygiene hook, wired to two distinct triggers in .claude/settings.json.

1. PreToolUse on `Write`, scoped (in-script) to brand-new files under
   `apps/<app>/migrations/`. If the target app already introduced a new
   migration file earlier in this task (per the `django-migration-standards`
   skill's one-migration-per-task rule), this asks for confirmation instead
   of letting a second file get created silently — the intended fix is to
   edit the existing new migration and re-apply it
   (`migrate <app> <migration_before_this_task>` then `migrate <app>`), not
   add another file. Editing an existing migration file is unaffected: Write
   to a path that already exists on disk is not "creating new" and passes
   through untouched.

2. PreToolUse on `Skill`, scoped (in-script) to the code-review skills
   (erp-code-review, erp-review, erp-review-mr). This inspects the same diff
   scope a review would use — uncommitted changes first, falling back to the
   current branch vs dev — and reports two things as review findings, in the
   exact `[SEVERITY] path:line — problem` / `Fix:` format the review skill
   already uses, so they fold into its aggregated output like any other
   finding instead of arriving as a separate notice:
     - a touched `apps/<app>/models.py` with no matching migration under
       apps/<app>/migrations/ (backend-django.md: migrations are mandatory
       whenever models or schema change)
     - an app with 2+ new migration files still unmerged for this task
       (django-migration-standards: one-migration-per-task)

Neither trigger runs at SubagentStop anymore — the check no longer fires at
the end of every backend-agent run, only when a migration is actually about
to be created or a review is actually being run.

Trigger 1 can ask for confirmation (permissionDecision "ask"); trigger 2
never blocks — it only injects additionalContext plus a systemMessage so the
finding surfaces to the model, to be folded into the review's output.
"""

import json
import os
import re
import subprocess
import sys

TARGET_SKILLS = {"erp-code-review", "erp-review", "erp-review-mr"}

MODEL_RE = re.compile(r"^apps/([^/]+)/models\.py$")
MIGRATION_RE = re.compile(r"^apps/([^/]+)/migrations/(?!__init__\.py$).+\.py$")
NEW_MIGRATION_FILE_RE = re.compile(r"^apps/([^/]+)/migrations/(?!__init__\.py$)\d{4}_.+\.py$")


def run_git(args: list[str]) -> str:
    return subprocess.run(
        ["git"] + args, capture_output=True, text=True, check=False
    ).stdout


def get_changed_files() -> tuple[set[str], str | None]:
    """Return (changed_file_paths, scope_label) for the diff a review would cover."""
    status = run_git(["status", "--porcelain"])
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
        diff = run_git(["diff", "--name-only", merge_base.stdout.strip(), "HEAD"])
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


def get_tracked_base() -> str:
    upstream = subprocess.run(
        ["git", "rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"],
        capture_output=True,
        text=True,
        check=False,
    )
    if upstream.returncode == 0 and upstream.stdout.strip():
        return upstream.stdout.strip()
    return "origin/dev"


def get_new_migrations_by_app() -> dict[str, list[str]]:
    """Group this task's new (not-yet-merged) migration files by app.

    Combines committed history since the tracked base with the working tree,
    per django-migration-standards' "Detection — run live, every time".
    """
    by_app: dict[str, list[str]] = {}
    base = get_tracked_base()
    merge_base = subprocess.run(
        ["git", "merge-base", "HEAD", base], capture_output=True, text=True, check=False
    )
    if merge_base.returncode == 0 and merge_base.stdout.strip():
        diff = run_git(
            [
                "diff",
                "--name-status",
                "--diff-filter=A",
                f"{merge_base.stdout.strip()}..HEAD",
                "--",
                "apps/*/migrations/*.py",
            ]
        )
        for line in diff.splitlines():
            parts = line.split("\t")
            if len(parts) != 2:
                continue
            match = NEW_MIGRATION_FILE_RE.match(parts[1])
            if match:
                by_app.setdefault(match.group(1), []).append(parts[1])

    status = run_git(["status", "--porcelain", "--", "apps/*/migrations/*.py"])
    for line in status.splitlines():
        code = line[:2]
        path = line[3:].split(" -> ")[-1].strip()
        if "A" in code or "?" in code:
            match = NEW_MIGRATION_FILE_RE.match(path)
            if match and path not in by_app.get(match.group(1), []):
                by_app.setdefault(match.group(1), []).append(path)

    return by_app


def handle_write(payload: dict) -> dict | None:
    """Guard against a second new migration file landing in an app mid-task."""
    file_path = (payload.get("tool_input") or {}).get("file_path")
    if not file_path:
        return None

    cwd = payload.get("cwd") or os.getcwd()
    relative_path = os.path.relpath(file_path, cwd) if os.path.isabs(file_path) else file_path
    match = NEW_MIGRATION_FILE_RE.match(relative_path)
    if not match:
        return None

    if os.path.exists(file_path):
        return None

    app = match.group(1)
    existing = get_new_migrations_by_app().get(app)
    if not existing:
        return None

    reason = (
        f"apps/{app}/migrations/ already has a new migration for this task "
        f"({', '.join(sorted(existing))}). Per django-migration-standards "
        "(one-migration-per-task), don't create another migration file for the "
        f"same app unless this is a deliberate schema/data split — update "
        f"{sorted(existing)[-1]} with the additional operations instead, then "
        "re-apply it: `python manage.py migrate "
        f"{app} <migration_before_this_task>` followed by `python manage.py "
        f"migrate {app}`. If a split is genuinely intentional, confirm that "
        "explicitly and document the reason in both files' docstrings before "
        "proceeding."
    )
    return {
        "systemMessage": (
            f"🛑 Migration check: {app} already has a new migration this task — "
            "update it instead of creating another."
        ),
        "hookSpecificOutput": {
            "hookEventName": "PreToolUse",
            "permissionDecision": "ask",
            "permissionDecisionReason": reason,
        },
    }


def build_review_findings(missing_apps: list[str], duplicate_apps: dict[str, list[str]], scope: str) -> str:
    findings = []
    for app in missing_apps:
        findings.append(
            f"[BLOCKER] apps/{app}/models.py:1 — model/schema change with no "
            f"matching migration under apps/{app}/migrations/ ({scope})\n"
            f"  Fix: run `python manage.py makemigrations {app}` and include "
            "the migration in this MR. See .claude/rules/backend-django.md."
        )
    for app, files in sorted(duplicate_apps.items()):
        findings.append(
            f"[SUGGESTION] apps/{app}/migrations/ — {len(files)} new migrations "
            f"added for this task in the same app ({', '.join(sorted(files))})\n"
            "  Fix: hand-merge into a single migration file unless this is a "
            "deliberate schema/data split — propose the merge and wait for "
            "confirmation before applying. See "
            ".claude/skills/django-migration-standards/SKILL.md."
        )
    return "\n\n".join(findings)


def handle_skill(payload: dict) -> dict | None:
    skill_name = (payload.get("tool_input") or {}).get("skill")
    if skill_name not in TARGET_SKILLS:
        return None

    changed_files, scope = get_changed_files()
    if not scope:
        return None

    missing_apps = find_missing_migrations(changed_files)
    duplicate_apps = {
        app: files for app, files in get_new_migrations_by_app().items() if len(files) >= 2
    }
    if not missing_apps and not duplicate_apps:
        return None

    findings_block = build_review_findings(missing_apps, duplicate_apps, scope)
    flagged_apps = sorted(set(missing_apps) | set(duplicate_apps))
    context = (
        "MIGRATION CHECK — fold these into the review's Findings section, same "
        "format as the other agents' output:\n\n"
        f"{findings_block}"
    )
    return {
        "systemMessage": (
            f"⚠️ Migration check: flag(s) for {', '.join(flagged_apps)} — see "
            "additionalContext for the review-ready findings."
        ),
        "hookSpecificOutput": {
            "hookEventName": "PreToolUse",
            "permissionDecision": "allow",
            "permissionDecisionReason": context,
            "additionalContext": context,
        },
    }


def main() -> None:
    try:
        payload = json.load(sys.stdin)
    except (json.JSONDecodeError, ValueError):
        sys.exit(0)

    tool_name = payload.get("tool_name")
    output = None
    if tool_name == "Write":
        output = handle_write(payload)
    elif tool_name == "Skill":
        output = handle_skill(payload)

    if output:
        print(json.dumps(output))
    sys.exit(0)


if __name__ == "__main__":
    main()
