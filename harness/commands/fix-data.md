---
description: Write a standalone Django script to fix inconsistent prod data, with dry-run default, logging, and rollback safety. The CEO runs it on prod.
model: claude-opus-4-6
---

<!--
Model rationale: This script runs against prod data with no undo. Getting the
correction logic wrong, bypassing signals unintentionally, or mis-scoping the
filter can corrupt data permanently. The extra reasoning cost of Opus 4.6 is
cheap insurance compared to a botched prod fix. Dry-run and atomic transactions
are safety rails, but the underlying logic still needs to be correct the first time.
-->


# Fix Data

You are writing a **standalone Python script** that will be sent to the CEO to run on the prod Django server. It fixes inconsistent data found by `/investigate-data`. This only runs after the user has confirmed the inconsistency is real and decided on the correct fix.

**Apply the `script-writing-standards` skill** for repo-wide script conventions (test-user email domain, scope constants, DRY_RUN default, sentinel naming, etc.). The rules below are additive on top of that skill.

## Important Context

- The script is a **standalone `.py` file**, not a Django management command.
- It is run inside a Django shell environment on prod.
- The script must be **self-contained and copy-paste-runnable**.
- The CEO runs it and sends the output back — so the output must show exactly what was changed (or what would be changed in dry-run mode).
- There is no "undo" — the script must be correct before it runs.

## Input

The user will provide:
- The inconsistency to fix (usually from `/investigate-data` output)
- The correction logic (what the correct value should be, and how to derive it)
- Whether the inconsistency came from a code loophole (if yes, the code fix is a separate change — this script only cleans up existing bad data)

If any of this is missing, ask before writing.

## Your Task

Write a single standalone Python script that safely corrects the bad data.

### Script Requirements

- **Location:** Ask the user where to save it, or default to `/tmp/fix_<short_name>.py`.
- **DRY_RUN flag — ASK before adding.** Do not add `DRY_RUN` on your own. The script is normally tested locally before being handed to the CEO, so a single-run script (no flag) is the default. If you think a DRY_RUN flag would help, ask the user — only add it if they confirm. If they want one, default it to `True` and the CEO must flip to `False` to apply.
- **Atomic transaction** — wrap the fix in `transaction.atomic()` so partial failures roll back.
- **Print every change** — before/after values for every record touched, printed to stdout. The CEO sends this output back, so it must be self-contained evidence of what happened.
- **Scope at the top** — filter constants (person_ids, ids, date range) as uppercase constants at the top, same pattern as `investigate-data`.
- **Count confirmation built in** — if the number of records to fix exceeds a threshold (default 100), the script must print a warning and refuse to run unless `CONFIRM_LARGE = True` is also set.
- **Re-verify after fix** — re-run the same inconsistency check on the fixed records and report any that still fail.
- **Never bypass signals silently** — prefer `record.save()` over `Model.objects.filter(...).update(...)`. If `.update()` is necessary for performance, print a warning listing which signals will be skipped.
- **Django ORM only** — no raw SQL (`cursor.execute()`, `connection.execute()`, `RawSQL`). Use QuerySet methods exclusively. If the user explicitly asks for raw SQL, comply only then.
- **No external dependencies** — just Django ORM and stdlib.

### Script Skeleton

```python
"""
Fix script for <inconsistency description>.

Run on prod via: python manage.py shell < fix_<name>.py

Purpose: <1-2 line explanation>
Root cause: <manual entry / code loophole — reference the related investigation>
Related: <bug report / ticket reference>
Date: <today>
Author: Ibrahim

"""

# ===== Safety controls (edit these to apply) =====
# DRY_RUN flag intentionally omitted — only add if the user explicitly asks.
CONFIRM_LARGE = False     # Set to True to allow fixing >100 records
LARGE_THRESHOLD = 100
# ===== Scope (edit to narrow the fix) ============
PERSON_IDS = None         # None = all matching records, or [1, 2, 3]
RECORD_IDS = None         # None = all matching, or [123, 456]
DATE_FROM = "2026-01-01"
DATE_TO = "2026-04-11"
# =================================================

from django.db import transaction
from apps.<module>.models import <Model>
# ... other imports

def find_broken_records():
    """Return queryset of records that need fixing. Same logic as the investigation script."""
    qs = <Model>.objects.filter(...).select_related(...)
    if PERSON_IDS:
        qs = qs.filter(person_id__in=PERSON_IDS)
    if RECORD_IDS:
        qs = qs.filter(id__in=RECORD_IDS)
    # Inconsistency filter (same as investigate_*)
    qs = qs.filter(<inconsistency condition>)
    return qs

def compute_fix(record):
    """Return the corrected value(s) for this record."""
    # <derivation logic>
    return {"<field>": <new_value>}

def verify_fixed(record):
    """Re-check this record after fix. Return (ok: bool, reason: str)."""
    # <same check as the investigation script, but on a single record>
    return True, ""

def main():
    print("=" * 60)
    print(f"FIX: <inconsistency description>")
    print("=" * 60)

    broken = list(find_broken_records())
    total = len(broken)
    print(f"\nRecords to fix: {total}")

    if total == 0:
        print("Nothing to do.")
        return

    if total > LARGE_THRESHOLD and not CONFIRM_LARGE:
        print(f"\nREFUSING TO RUN: {total} records exceeds threshold {LARGE_THRESHOLD}.")
        print("Set CONFIRM_LARGE = True at the top of the script to proceed.")
        return

    # Show a sample
    print("\nSample (first 10):")
    for record in broken[:10]:
        fix = compute_fix(record)
        for field, new_value in fix.items():
            old_value = getattr(record, field)
            print(f"  {<Model>.__name__}#{record.id}: {field}: {old_value!r} -> {new_value!r}")

    # Apply
    print(f"\nApplying fix to {total} records...")
    changes = []
    still_failing = []

    try:
        with transaction.atomic():
            for record in broken:
                fix = compute_fix(record)
                before = {f: getattr(record, f) for f in fix}
                for field, new_value in fix.items():
                    setattr(record, field, new_value)
                record.save()
                after = {f: getattr(record, f) for f in fix}
                changes.append({
                    "id": record.id,
                    "before": before,
                    "after": after,
                })

                ok, reason = verify_fixed(record)
                if not ok:
                    still_failing.append({"id": record.id, "reason": reason})

            if still_failing:
                print(f"\n{len(still_failing)} records still failed verification after fix:")
                for f in still_failing:
                    print(f"  {<Model>.__name__}#{f['id']}: {f['reason']}")
                # Decide: raise to roll back, or accept partial?
                # Default: raise to roll back the whole transaction.
                raise RuntimeError("Verification failed after fix — rolling back.")

    except Exception as e:
        print(f"\nTRANSACTION ROLLED BACK: {e}")
        print("No changes were applied.")
        return

    # Success report
    print(f"\nFix applied successfully. Changes:")
    for c in changes:
        print(f"  {<Model>.__name__}#{c['id']}: {c['before']} -> {c['after']}")
    print(f"\nTotal updated: {len(changes)}")
    print(f"Verification: all {len(changes)} records passed re-check.")

main()
```

## Rules

- **Do NOT add a DRY_RUN flag on your own.** The expected workflow: the team tests the script locally on seeded/staging data, then hands a single-run script to the CEO. Asking the CEO to run something twice (once to preview, once to apply) is not viable. Only add a DRY_RUN flag if the user explicitly asks.
- **Wrap the entire apply block in `transaction.atomic()`.** If verification fails after the fix, raise to roll back the whole thing.
- **Print before/after for every record changed.** The output is the audit trail — there's no second run to check.
- **Never bypass signals silently.** Use `save()` unless there's a documented reason to use `.update()`, and if you do, print a warning.
- **Don't fix the underlying code bug in this script.** This script only cleans existing data. The code fix is a separate change.
- At the end, tell the user:
  - The file path where the script was saved
  - The exact command the CEO should run (e.g., `python manage.py shell < <path>`)
  - A reminder to test the script locally on seeded data before sending it to the CEO
