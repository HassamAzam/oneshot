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

Two patterns coexist. Of the 108 commands in `apps/*/management/commands/`, 78 take no arguments at all and 30 declare `add_arguments`.

- **Date-based auto-detection** (the majority — `notify_person_project_logs.py:69,74`): the command reads `date.today()` itself and branches on weekday or month-end. No arguments. Simple, but every branch lives in one command and a bug in the date logic hits all of them at once.
- **`add_arguments`** — used in this repo for exactly three jobs: a **date or window** to operate over (`--month`, `--for-date`, `--year`, `--start`/`--end`, `--before`/`--after`), the **entity to scope to** (`--person`, `--team`, `--teams`), and a **safety toggle** (`--dry-run`, `--confirm-large`). Reach for it when a human or a backfill has to re-run the command over a period the clock would not pick on its own — that is what makes the logic re-runnable and testable without waiting for the calendar.

**No command here selects among N variants of the same logic by flag** — there are zero uses of `choices=` across all 108. If a ticket seems to want that shape (three reminder slots, say), treat it as a new pattern rather than the house style: weigh one flag per caller against N branches in a date-sniffing `handle()` on the merits, and do not expect a precedent to cite.

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
