---
name: django-scheduled-jobs
description: How recurring work actually gets scheduled in this ERP repo — a management command registered on the server crontab by DevOps, never a django_celery_beat PeriodicTask/CrontabSchedule row created in app code or seeded in a migration. Covers the one legitimate exception (dynamically-timed per-entity one-off tasks) and the mandatory ops handoff. Trigger whenever a ticket asks for scheduled, periodic or cron-driven behaviour — "send X every week", "run this monthly", "periodic reminder", "nudge on day N", "every N days", "on the 1st", "recurring" — or whenever a diff touches PeriodicTask, CrontabSchedule or a crontab entry.
---

# Scheduled Jobs

How fixed-cadence work reaches dev, stage and prod. This is a **deployment and ownership** question, not a coding-style one, and the default answer most tickets reach for is wrong.

For writing the command itself — `BaseCommand` shape, thin `handle()`, idempotency, testing — read **`django-management-commands`**. This skill assumes the command exists or is being written and answers only: how does it get run on a schedule.

---

## The rule

**Fixed-cadence / recurring work (weekly, monthly, "every N days", "on day 3/5/7") is a management command registered on the server crontab by DevOps — never a `django_celery_beat` `PeriodicTask`/`CrontabSchedule` row created in app code or seeded via a data migration.**

There is no precedent anywhere in this repo for a migration or app code creating a *repeating* `PeriodicTask`/`CrontabSchedule` row for this purpose — confirmed by grep across every `apps/*/migrations/`. The actual mechanism for every existing weekly/monthly reminder (`notify_person_project_logs`, `send_competency_deadline_reminder`, `contract_renewal_reminder`, `birthday_anniversary_notifications`, ~20 more) is: write the command, and DevOps adds a crontab line calling `python manage.py <command>` on a schedule.

That registration happens **outside this repo**. Your MR cannot contain it — which is exactly why the MR has to make it unmissable. See the deploy handoff below.

## The one exception — dynamic per-entity one-off tasks

`PeriodicTask.objects.get_or_create(..., one_off=True)` and `create_or_update_repeating_cron_periodic_task` (`common/utils.py:2067`) **are** legitimate — for a different shape of problem: a *single, dynamically-timed execution keyed to one business entity*, created at runtime as a side effect of business logic.

Precedent: `apps/costing/utils.py` (`create_gratuity_calculation_task`, `create_annual_bonus_calculation_task` — one recalculation for one person on a computed future date) and `apps/competencies/management/commands/send_competency_reminder_periodically.py` (one reminder per person per review cycle).

### The test

> **Is the schedule the same clock time for everyone, decided at build time?** → crontab + management command.
> **Is it a one-off execution timed per business event or entity, decided at runtime?** → `PeriodicTask(one_off=True)` is fine.

Being able to cite a file that uses `PeriodicTask` is not evidence that your case may. Check which side of that test the cited file is on first — `apps/costing/utils.py` is the most commonly mis-cited precedent in this repo, and it is on the one-off side.

### Gotcha if you use `create_or_update_repeating_cron_periodic_task`

Its `**task_args` are packaged as a **single dict**, passed as the task's one positional argument (`args=json.dumps([task_args])`). The consuming task must accept one dict parameter — see `send_periodic_competency_reminder_task(competency_data)` — not unpacked scalar arguments.

---

## Deploy handoff — mandatory when a command needs a schedule

Whenever a new or changed command needs a crontab entry — a new schedule, a changed cadence, or a legacy entry that must be removed or superseded — do **both**:

1. Add the "Ops action required" item to the MR description. Fill in `templates/ops-checklist.md`.
2. Post a matching comment on the GitLab ticket. The MR merges and closes; the ops follow-up can lag behind it, so the ticket is where it stays visible until done.

Never assume a crontab entry exists because the command exists and the MR merged. Verify with ops before relying on the schedule in QA — and if a reminder appears not to be firing after a deploy, this is the first thing to check and the checklist item is what you cite.
