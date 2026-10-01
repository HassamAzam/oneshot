---
name: django-management-commands
description: How to write a Django management command in this ERP repo — BaseCommand shape, thin handle(), add_arguments vs date-based auto-detection, idempotency, delegating to Celery, and testing. Trigger whenever writing or reviewing a file under apps/<app>/management/commands/, or when a ticket asks for a CLI-invoked repeatable operation (backfill, one-off import, nightly export). Does NOT cover how a command gets scheduled — read django-scheduled-jobs for that.
---

# Django Management Commands

Canonical shape for a tracked, repeatable operation in this repo — `apps/<app>/management/commands/<name>.py`.

**Scope.** This skill covers writing the command. Whether and how it runs on a schedule is a separate decision with its own rules and its own failure mode — read **`django-scheduled-jobs`** for that, and do not infer a scheduling mechanism from anything in this file.

Additive to `django-backend-standards` and `.claude/rules/backend-python.md` — both still apply.

---

## Structure

Start from `templates/command.py`. Three things in that template are repo conventions rather than Django defaults, and each exists for a reason:

- **`handle()` is a thin CLI entrypoint.** Real logic lives in `utils.py` or on model methods — the same separation of concerns views follow. This is what makes the logic unit-testable directly, without going through `call_command`.
- **`handle()` wraps its call in `try/except Exception` and logs via `logger.exception(...)`.** A command invoked from an external crontab has nobody watching stdout, so an unhandled exception must land in the logs instead of silently killing the process. `notify_person_project_logs.py:90-91` is the pattern to copy. Treat this as a rule to follow rather than a majority to imitate: only 48 of the 108 command files contain any `except` at all, and `send_competency_deadline_reminder.py` — a live reminder — has none, which is precisely why a failure in it is invisible.
- **Logging obeys `.claude/rules/backend-python.md` § "Logging — Which Logger and Which Level".** That table is authoritative — which logger name, which level, and the trap that `getLogger(__name__)` silently drops INFO and WARNING in prod. Read it rather than reconstructing the rule from memory; a command that needs a durable INFO line needs a second, explicitly-named logger, and the table says which.

## `add_arguments` vs. date-based auto-detection

**ERP stores no schedule.** No model holds a cron expression, cadence, or reminder calendar — for crontab-driven work the schedule exists only in a crontab line on a server, outside this repo and outside version control. That single fact decides this section.

Because the schedule is not in the repo, **"am I due right now?" must be answered in the repo.** The majority pattern does exactly that: `notify_person_project_logs.py:74` compares `date.today().weekday()` against `FRIDAY_WEEK_DAY_CONSTANT` from `common/constants.py`. The intent is a named constant a reviewer can check and a test can assert. 78 of the 108 commands take no arguments at all and work this way.

The failure mode of the alternative is the whole point. A flag like `--reminder 2` that says *which slot of the schedule this invocation is* moves the meaning of "2" into the crontab line. Nothing in ERP then records that three slots exist, which days they fall on, or that slot 2 is Friday's. The repo cannot express it, no test can assert it, and if ops registers it on the wrong day nothing here contradicts them. You have split one concept across two systems and left the authoritative half unversioned.

So: **do not encode schedule semantics in a flag.** `add_arguments` is for inputs ERP genuinely owns, which in this repo means exactly three things:

- a **date or window** to operate over — `--month`, `--for-date`, `--year`, `--start`/`--end`, `--before`/`--after`
- the **entity to scope to** — `--person`, `--team`, `--teams`
- a **safety toggle** — `--dry-run`, `--confirm-large`

All three are parameters a human or a backfill supplies to re-run the command over something the clock would not pick on its own. None of them tells the command when it is due.

Zero of the 108 commands use `choices=`, and none selects among variants of the same logic by flag. If a ticket seems to call for that, the shape is usually a sign the schedule is leaking into the arguments — put the cadence in a constant and branch on the date instead. If you still need it, say so explicitly in the MR rather than letting it imply precedent.

## Idempotency

A command can run twice — a manual re-run, an overlapping ops retry. Filter defensively (`is_completed=False`, `get_or_create` / `update_or_create`) so a second run does not double-process or double-send. "It only runs once a day" is not a safety net; it is an assumption about a caller this repo does not control.

## Delegating to Celery

If the work is more than a quick query — sending mail, heavy computation — have `handle()` (or the `utils.py` function it calls) hand off via `.delay()` rather than running synchronously. Keeps the command fast and makes retries independent of mail and compute latency. Pattern: `notify_person_project_logs.py` (`notify_project_logs_fill.delay(person_log_list)`).

## Testing

- **Name it `apps/<app>/tests/<command_name>_test.py`, then import its test class in `apps/<app>/tests/__init__.py`.** The import is what collects the test; the filename alone does nothing. `common.tests.GlobalTestRunner` extends `DiscoverRunner` and overrides `__init__`, `get_resultclass`, `setup_databases` and `build_suite` — but never `pattern` — so Django's default `test*.py` stands and `*_test.py` matches none of it. All 505 `*_test.py` files under `apps/*/tests/` run purely because an `__init__.py` imports them.
- **Skipping that import fails silently.** `apps/advisory/tests/checklist_test.py` is on `dev`, is imported nowhere, and has therefore never run once. Correct suffix, zero execution, no error.
- Call the extracted `utils.py` function directly, or `call_command("<name>", ...)` when you need to exercise `add_arguments` parsing.
- Mock `.delay()` and assert on its arguments rather than on delivered mail.
- Cover the empty queryset (nobody to notify), the idempotency guard (second run is a no-op), and each `add_arguments` branch separately.

---

## Before you call it done

Load `refs/validation-checklist.md` and walk it against what you wrote. This file is the explanation; that file is the check.

Budget for its **Evidence** section before you declare done. Everything else on that list can be satisfied by a command that has never once executed — the evidence items cannot, and they are where the real failures live: a command whose `--help` is broken, a guard that does not actually make the second run a no-op, a test that was written but never collected, an exception handler nobody has seen fire.
