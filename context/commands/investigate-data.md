---
description: Write a read-only standalone Django script to pull prod data and flag inconsistencies. The CEO runs it on prod and sends back the output.
model: claude-sonnet-4-6
---

<!--
Model rationale: Script-writing work is largely mechanical — Django ORM patterns,
filter composition, print formatting. Sonnet 4.6 handles this well and at lower
cost. The sensitivity gate around compensation tables requires judgment, but it's
rule-following, not open-ended reasoning. If the investigation is unusually
complex (multi-module, ambiguous scope), the user can manually escalate to Opus
for that run.
-->


# Investigate Data

You are writing a **standalone, read-only Python script** that will be sent to the CEO to run on the prod Django server. The user does not have prod access. This runs AFTER `/investigate-bug` has confirmed the code is correct (or found a loophole and wants to check the data impact).

**Apply the `script-writing-standards` skill** for repo-wide script conventions (test-user email domain, scope constants, sentinel naming, etc.). The rules below are additive on top of that skill.

## Important Context

- The script is a **standalone `.py` file**, not a Django management command.
- It is run inside a Django shell environment on prod (e.g., `python manage.py shell < script.py` or the CEO runs it via `exec(open('script.py').read())` in a shell, or via `runscript`).
- Assume Django is already set up in the runtime — models can be imported directly.
- The script will be sent as a file, so it must be **self-contained and copy-paste-runnable**.
- **The output of the script is what comes back to the user** — so the output must be clear, detailed, and contain enough context to reach a conclusion without needing a follow-up run.

## Input

The user will provide context on what to look for:
- The bug report / investigation outcome (from `/investigate-bug`)
- The module(s) and model(s) involved
- What "correct" data looks like (check the app-level `CLAUDE.md` for data integrity rules)

If this context is missing, ask for it before writing anything.

## Data Sensitivity Check — BEFORE WRITING THE SCRIPT

**Compensation data is sensitive.** Before writing any script, check whether the investigation needs to read from these tables (or similar ones representing person compensation):

- `Salary`
- `Increments`
- `ContractRevisions`
- `ContractorCompensations`
- `BonusAllocations`
- `TeamReviewBonus`
- `Bonus`
- Any table that stores per-person amounts, pay rates, or compensation history

**If the script will touch any of these tables, you MUST stop and ask the user for confirmation before writing a single line of code.**

### Extraction Policy (in order of preference)

1. **Inconsistency-only reporting (preferred)** — Detect the inconsistency inside the script and report only the fact that it exists, not the underlying compensation values. Example: `"Person #123 has salary mismatch between Salary and Increments tables"` — no amounts printed.

2. **Aggregated / anonymized output** — If raw values are needed for context, extract them in a form that does not expose individual compensation. Examples:
   - Sum across multiple people: `"Total salary delta across 12 affected records: 45000"`
   - Hashed/truncated identifiers
   - Ratios / differences instead of absolute values: `"record #123: new value is 1.07x old value"`

3. **Raw data (last resort, DISCOURAGED but NOT PROHIBITED)** — If the bug cannot be resolved without seeing actual compensation amounts, extract them. Resolving the bug is the top priority.

### Confirmation Prompt

Before writing the script, present this to the user:

```
This investigation will touch compensation-sensitive tables:
  - <list the specific tables>

Proposed extraction approach:
  Tier <1|2|3>: <one-line description of what the script will output>

Sample of what the output will look like:
  <2-3 lines of representative output — inconsistency-only, aggregated, or raw>

Alternatives considered:
  - <any less-sensitive approaches you considered and why they don't work, or "none — tier 1 is sufficient">

Proceed with this approach, or choose a different tier?
```

**Wait for the user's explicit OK before writing the script.** Do not assume. Do not default to raw.

If the investigation does NOT touch any compensation tables, skip this section entirely and proceed.

---

## Your Task

Write a single standalone Python script that:

1. Imports the relevant models directly
2. Pulls the relevant records (scoped reasonably — do NOT scan the whole DB)
3. Flags inconsistencies against the data integrity rules
4. Prints a detailed report that lets the user determine whether the bug is a manual data entry mistake or a code loophole

### Script Requirements

- **Location:** Ask the user where they want the script saved, or default to a scratch location like `/tmp/investigate_<short_name>.py` and let them move it. Do not assume a fixed repo path.
- **Self-contained** — all imports at the top, no external arguments (hardcode the scope at the top of the file as constants the CEO can edit if needed).
- **READ ONLY** — no `save()`, no `.update()`, no `.delete()`, no `.create()`. If you catch yourself writing one of these, stop.
- **Django ORM only** — no raw SQL (`cursor.execute()`, `connection.execute()`, `RawSQL`). Use QuerySet methods exclusively. If the user explicitly asks for raw SQL, comply only then.
- **Use `select_related` / `prefetch_related`** — scripts run on prod, N+1 queries matter.
- **Scope at the top** — put filter constants (date range, person IDs, fiscal year, etc.) as uppercase constants at the top of the file so they're easy to spot and edit.
- **Detailed print output** — use plain `print()` (the CEO sends output back as text). No styling, no colors. Include enough context per record to identify it: ID, person name+id, relevant field values, timestamps, `created_by` if available.
- **No external dependencies** — just Django ORM and stdlib.

### Script Skeleton

```python
"""
Investigation script for <bug description>.

Run on prod via: python manage.py shell < investigate_<name>.py
Or:              python manage.py runscript investigate_<name>

Purpose: <1-2 line explanation>
Related: <bug report / ticket reference>
Date: <today>
Author: Ibrahim
"""

# ===== Scope (edit these if needed) =====
DATE_FROM = "2026-01-01"
DATE_TO = "2026-04-11"
PERSON_IDS = None  # None = all, or [1, 2, 3] for specific people
# ========================================

from django.db.models import Q, Count, F
from apps.<module>.models import <Model>
# ... other imports

def main():
    print("=" * 60)
    print("INVESTIGATION: <bug short description>")
    print(f"Scope: {DATE_FROM} to {DATE_TO}")
    print("=" * 60)

    # Build base queryset with scoping
    qs = <Model>.objects.filter(...).select_related(...).prefetch_related(...)
    if PERSON_IDS:
        qs = qs.filter(person_id__in=PERSON_IDS)

    total_scanned = qs.count()
    print(f"\nTotal records scanned: {total_scanned}\n")

    inconsistencies = []

    # Check 1: <name> — rule from apps/<module>/CLAUDE.md: <rule>
    for record in qs:
        if <inconsistency condition>:
            inconsistencies.append({
                "check": "<check name>",
                "model": "<Model>",
                "id": record.id,
                "person": f"{record.person.full_name} (id={record.person_id})" if record.person_id else "N/A",
                "issue": "<what's wrong>",
                "expected": "<correct value>",
                "actual": "<actual value>",
                "created_at": record.created_at,
                "created_by": getattr(record, "created_by", None),
                "updated_at": record.updated_at,
            })

    # Report
    print(f"Inconsistencies found: {len(inconsistencies)}\n")
    for i, inc in enumerate(inconsistencies, 1):
        print(f"[INCONSISTENCY {i}]")
        for k, v in inc.items():
            print(f"  {k}: {v}")
        print()

    # Summary with manual-vs-code hints
    print("=" * 60)
    print("SUMMARY")
    print("=" * 60)
    print(f"Total scanned:     {total_scanned}")
    print(f"Total inconsistent: {len(inconsistencies)}")

    # Breakdown by check
    from collections import Counter
    by_check = Counter(inc["check"] for inc in inconsistencies)
    for check, count in by_check.items():
        print(f"  - {check}: {count}")

    # Hints for manual vs code
    if inconsistencies:
        by_creator = Counter(str(inc["created_by"]) for inc in inconsistencies)
        print("\nCreated-by breakdown (hint: if clustered on admin users, likely manual):")
        for creator, count in by_creator.most_common():
            print(f"  - {creator}: {count}")

        # Timestamp clustering hint
        timestamps = sorted(inc["created_at"] for inc in inconsistencies if inc["created_at"])
        if len(timestamps) >= 2:
            span = timestamps[-1] - timestamps[0]
            print(f"\nTimestamp span: {span} (hint: tight cluster = code flow, wide spread = manual)")

main()
```

### Manual vs Code Hints

Always include these in the output — they are the whole point of the investigation:
- **`created_by` breakdown** — clustered on admin users → likely manual
- **Timestamp spread** — tight cluster → code flow; scattered → manual
- **Missing paired records** — if related records that should exist together are missing one side, suggests signals didn't fire → code loophole
- **UI-enforced fields empty** — suggests the record was set via admin/script, not the UI

## Rules

- READ ONLY. If you feel tempted to add a fix step, stop — that's `/fix-data`.
- Do NOT assume the script will be run with arguments. Scope goes in constants at the top.
- Print everything the user will need to reach a conclusion — the CEO copies the output back, there's no second chance.
- Cite the app-level `CLAUDE.md` rule each check is based on as a comment above the check.
- At the end, tell the user: the file path you saved the script to, and the exact command the CEO should run (e.g., `python manage.py shell < <path>` or `python manage.py runscript <name>`).

## Sidecar Context File (for resuming in a new session)

Alongside the script, write a sidecar markdown file at the same path with `.context.md` appended (e.g., `/tmp/investigate_leave_balance.py` → `/tmp/investigate_leave_balance.py.context.md`). This file captures everything needed to resume analysis later if the CEO doesn't run the script immediately.

The sidecar must contain:

```markdown
# Investigation Context: <bug short description>

**Date:** <today>
**Related bug:** <ticket / link / description>
**Module:** <app>
**Model(s):** <Model1, Model2>
**Script:** <absolute path to the .py file>

## Why We're Investigating
<1-2 sentences — what investigate-bug concluded, or what the user asked to check>

## What the Script Checks
<bullet list of each inconsistency check, referencing the CLAUDE.md rule>

## Scope
- Date range: <from> to <to>
- Person filter: <None / list>
- Other filters: <...>

## How to Resume In a New Session
Open a fresh Claude session and paste:

    I ran an investigation script earlier. Here's the context and the output from prod.
    Read the context file and the script, then analyze the output.

    Context file: <absolute path to this sidecar>
    Script: <absolute path to .py file>

    ## Output from prod
    <paste CEO's output here>

Claude will read both files, analyze the output, and produce a handoff block for /fix-data if needed.
```

Tell the user both file paths at the end — the script and the sidecar.

## After the CEO Sends Output Back

When the user pastes the script output, analyze it and help them decide if the data is really inconsistent, and whether it's manual entry or a code loophole. Then produce a **handoff block** they can paste into `/fix-data` if a fix is needed:

```
Module: <app name>
Model: <Model>
Inconsistency: <what's wrong, quoted from script output>
Scope: <which record IDs / persons / date range are affected>
Root cause: <manual entry OR code loophole — reference investigate-bug findings>
Correction logic: <how to derive the correct value — e.g., "leave_balance = allocated - used">
Records affected: <count from script output>
```

If the fix logic isn't obvious from the data, ask the user before writing the handoff block — the fix derivation is their call, not yours.
