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
- **`handle()` wraps its call in `try/except Exception` and logs via `logger.exception(...)`.** A command invoked from an external crontab has nobody watching stdout, so an unhandled exception must land in the logs instead of silently killing the process. Every existing reminder command does this (`notify_person_project_logs.py`, `send_competency_deadline_reminder.py`).
- **Logging obeys `.claude/rules/backend-python.md` § "Logging — Which Logger and Which Level".** That table is authoritative — which logger name, which level, and the trap that `getLogger(__name__)` silently drops INFO and WARNING in prod. Read it rather than reconstructing the rule from memory; a command that needs a durable INFO line needs a second, explicitly-named logger, and the table says which.

## `add_arguments` vs. date-based auto-detection

Two valid patterns coexist here. Pick on what actually varies:

- **Date-based auto-detection** (majority — `notify_person_project_logs.py`): the command reads `date.today()` itself and branches on weekday or month-end. No arguments. Simple, but every branch lives in one command and a bug in the date logic hits all of them at once.
- **`add_arguments`** (`send_competency_feedback_form.py`, `generate_quarterly_checklists.py`): the caller picks the variant by passing a flag, e.g. `--reminder 2`. Prefer this when a ticket describes **N distinct invocations of the same underlying logic** — one command with one flag per caller, rather than N branches baked into a date-sniffing `handle()`.

## Idempotency

A command can run twice — a manual re-run, an overlapping ops retry. Filter defensively (`is_completed=False`, `get_or_create` / `update_or_create`) so a second run does not double-process or double-send. "It only runs once a day" is not a safety net; it is an assumption about a caller this repo does not control.

## Delegating to Celery

If the work is more than a quick query — sending mail, heavy computation — have `handle()` (or the `utils.py` function it calls) hand off via `.delay()` rather than running synchronously. Keeps the command fast and makes retries independent of mail and compute latency. Pattern: `notify_person_project_logs.py` (`notify_project_logs_fill.delay(person_log_list)`).

## Testing

- **File must be `apps/<app>/tests/<command_name>_test.py`.** Test discovery here ignores a bare `<command_name>.py`, so a test file named without the suffix is never collected and never runs. `apps/project_logs/tests/notify_person_project_logs.py` is a real example of a test file silently doing nothing.
- Call the extracted `utils.py` function directly, or `call_command("<name>", ...)` when you need to exercise `add_arguments` parsing.
- Mock `.delay()` and assert on its arguments rather than on delivered mail.
- Cover the empty queryset (nobody to notify), the idempotency guard (second run is a no-op), and each `add_arguments` branch separately.

---

## Before you call it done

Load `refs/validation-checklist.md` and walk it against what you wrote. It is the mechanical form of everything above — the rules in this file are the explanation, that file is the check.
