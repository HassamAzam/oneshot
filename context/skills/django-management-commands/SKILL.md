---
name: django-management-commands
description: How to write a Django management command in this ERP repo (BaseCommand shape, add_arguments, idempotency, logging, delegating to Celery, testing) and the scheduling SOP for recurring work — a management command registered on the server crontab by DevOps, never a django_celery_beat PeriodicTask/CrontabSchedule row created in app code or a migration. Trigger whenever writing or reviewing a management command, or when a ticket asks for scheduled/periodic/cron-driven automation ("send X every week", "run this monthly", "periodic reminder", "nudge on day N").
---

# Django Management Commands

Canonical shape for a tracked, repeatable operation in this repo — `apps/<app>/management/commands/<name>.py`. This skill covers how to write the command itself and, separately, how recurring execution actually gets scheduled in this codebase (most tickets get this second part wrong by default — read that section even if the command itself is trivial).

This is additive to `django-backend-standards` and `backend-python.md` — those still apply (logging, error handling, type hints).

---

## Command structure

```python
"""One-line docstring: what this command does and who/what triggers it."""

import logging

from django.core.management.base import BaseCommand

from apps.project_logs.utils import send_weekly_project_logs_reminder

logger = logging.getLogger(__name__)


class Command(BaseCommand):
    """Send the weekly project-log reminder for the given reminder slot."""

    def add_arguments(self, parser):
        parser.add_argument("--reminder", type=int, choices=[1, 2, 3], required=True)

    def handle(self, *args, **options):
        try:
            send_weekly_project_logs_reminder(options["reminder"])
        except Exception:
            logger.exception("Error while sending weekly project logs reminder.")
```

- All real logic lives in `utils.py` / model methods, not inline in `handle()` — the command is a thin CLI entrypoint, same separation of concerns as views. This makes the logic independently unit-testable without going through `call_command`.
- Wrap `handle()` in `try/except Exception: logger.exception(...)` — a command invoked from an external crontab has no one watching stdout; an unhandled exception must land in the logs, not just kill the process silently. This matches every existing reminder command (`notify_person_project_logs.py`, `send_competency_deadline_reminder.py`, etc.).
- `logger = logging.getLogger(__name__)` for the exception log (ERROR + traceback — see `backend-python.md`). If the command should also emit an INFO line worth keeping in prod ("sent reminder to N people"), use a **second**, explicitly-named `logging.getLogger("hrdb")` call for that line — `__name__` silently drops INFO in prod.

## `add_arguments` vs. date-based auto-detection

Two valid patterns coexist in this repo; pick based on what varies:

- **Date-based auto-detection** (majority pattern — `notify_person_project_logs.py`): the command inspects `date.today()` itself and branches on weekday/month-end. No arguments. Simple, but every branch lives inside one command and a bug in the date logic affects everything at once.
- **`add_arguments`** (e.g. `send_competency_feedback_form.py`, `generate_quarterly_checklists.py`): the *crontab entry itself* picks the variant by passing a flag, e.g. `--reminder 2`. Prefer this when a ticket describes **N distinct scheduled invocations of the same underlying logic** (like three weekly reminder slots) — one command, one flag per crontab line, rather than baking N branches into a single date-sniffing `handle()`.

## Idempotency

A crontab-triggered command can run twice (manual re-run, overlapping ops retry). Filter defensively — `is_completed=False`, `get_or_create`/`update_or_create` — so a second run does not double-process or double-send. Don't rely on "it only runs once a day" as your only safety net.

## Delegating to Celery

If the command's work is more than a quick query (sending mail, heavy computation), have `handle()` (or the `utils.py` function it calls) hand off to a Celery task via `.delay()` rather than running synchronously — keeps the command fast and retryable independent of mail/compute latency. See `apps/project_logs/management/commands/notify_person_project_logs.py` (`notify_project_logs_fill.delay(person_log_list)`) for the pattern.

## Testing

- File: `apps/<app>/tests/<command_name>_test.py` — must end in `_test.py` or it is never collected (this repo's test discovery ignores bare `<command_name>.py`; see `apps/project_logs/tests/notify_person_project_logs.py` for a real example of a test file that silently never runs because of this).
- Call the extracted `utils.py` function directly, or `call_command("<name>", ...)` for `add_arguments` parsing. Mock the `.delay()` call and assert on its arguments rather than asserting on delivered mail.
- Test edge cases: empty queryset (no one to notify), the idempotency guard (second run is a no-op), and each `add_arguments` branch separately.

---

## Scheduling SOP — how recurring execution actually reaches dev/stage/prod

**Fixed-cadence / recurring work (weekly, monthly, "every N days", "on day 3/5/7") is a management command registered on the server crontab by DevOps — never a `django_celery_beat` `PeriodicTask`/`CrontabSchedule` row created in app code or seeded via a data migration.**

There is no precedent anywhere in this repo for a migration or app code creating a repeating `PeriodicTask`/`CrontabSchedule` row for this purpose — confirmed by grep across every `apps/*/migrations/`. The actual mechanism for every existing weekly/monthly reminder (`notify_person_project_logs`, `send_competency_deadline_reminder`, `contract_renewal_reminder`, `birthday_anniversary_notifications`, ~20 more) is: write the command, and DevOps adds a crontab line that calls `python manage.py <command>` on a schedule. That registration step happens outside this repo and is not something your MR can contain — but the MR must make it unmissable (see Deploy checklist below).

### The one exception — dynamic per-entity one-off tasks

`PeriodicTask.objects.get_or_create(..., one_off=True)` / `create_or_update_repeating_cron_periodic_task` (`common/utils.py:2067`) **are** legitimate — but only for a different shape of problem: a *single, dynamically-timed execution keyed to one business entity*, created at runtime as a side effect of business logic. Precedent: `apps/costing/utils.py` (`create_gratuity_calculation_task`, `create_annual_bonus_calculation_task` — schedule one recalculation for one person on a computed future date) and `apps/competencies/management/commands/send_competency_reminder_periodically.py` (schedules one reminder per person per review cycle).

The test: **is the schedule the same clock time for everyone, decided at build time?** → crontab + management command. **Is it a one-off execution timed per business event/entity, decided at runtime?** → `PeriodicTask(one_off=True)` is fine.

If you use `create_or_update_repeating_cron_periodic_task`, remember its `**task_args` are packaged as a **single dict**, passed as the task's one positional argument (`args=json.dumps([task_args])`) — the consuming task must accept one dict parameter (see `send_periodic_competency_reminder_task(competency_data)`), not unpacked scalar arguments.

### Deploy checklist — mandatory when a command needs to run on a schedule

Whenever a new or changed management command needs a crontab entry (new schedule, changed cadence, or a legacy entry that must be removed/superseded), add an explicit checklist item to the MR description **and** a matching comment/action item on the GitLab ticket — the MR merges and closes, but the ops follow-up can lag behind it, so the ticket is where it stays visible until done.

```markdown
## Checklist
- [ ] Tested locally
- [ ] **Ops action required**: register on the server crontab —
      `0 9 * * 3,5,0 <path>/manage.py notify_project_logs_weekly_reminder --reminder <N>`
      (Wed/Fri/Sun 09:00, dev + stage + prod)
- [ ] **Ops action required**: remove/disable the legacy crontab entry for `<old_command>` if this supersedes it
```

Never assume a crontab entry got added just because the command exists and the MR merged — verify with ops before relying on the schedule in QA, and cite this checklist item as the reason if a reminder appears to not be firing post-deploy.
