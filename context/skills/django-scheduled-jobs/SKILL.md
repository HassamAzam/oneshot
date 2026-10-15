---
name: django-scheduled-jobs
description: How scheduled work actually reaches dev/stage/prod in this ERP repo. Fixed-cadence work that runs at the same time for everyone is a management command on the DevOps-managed server crontab; a PeriodicTask/CrontabSchedule row is never seeded in a data migration; and app code does legitimately create per-entity schedules at runtime, one-off or repeating. Covers all three cases, how to tell them apart, and the mandatory ops handoff. Trigger whenever a ticket asks for scheduled, periodic or cron-driven behaviour — "send X every week", "run this monthly", "periodic reminder", "nudge on day N", "every N days", "on the 1st", "recurring" — or whenever a diff touches PeriodicTask, CrontabSchedule or a crontab entry.
---

# Scheduled Jobs

How fixed-cadence work reaches dev, stage and prod. This is a **deployment and ownership** question, not a coding-style one, and the default answer most tickets reach for is wrong.

For writing the command itself — `BaseCommand` shape, thin `handle()`, idempotency, testing — read **`django-management-commands`**. This skill assumes the command exists or is being written and answers only: how does it get run on a schedule.

---

## The rule

**Work that runs at the same clock time for everyone, on a cadence fixed at build time (weekly, monthly, "on day 3/5/7"), is a management command registered on the server crontab by DevOps.** Do not seed it as a `django_celery_beat` `PeriodicTask`/`CrontabSchedule` row, and in particular never create one in a data migration.

Two separate claims, with separate evidence — keep them apart:

- **No migration in this repo seeds a schedule.** Verified by grep for `PeriodicTask` and `CrontabSchedule` across every `apps/*/migrations/`: zero hits. This half is absolute.
- **Fixed-cadence reminders are crontab-driven by convention.** `notify_person_project_logs`, `send_competency_deadline_reminder`, `contract_renewal_reminder`, `birthday_anniversary_notifications` and ~20 more are management commands that DevOps calls from a crontab line. This is the convention for that shape — it is *not* a claim that app code never creates a schedule. It does; see case 3 below.

Crontab registration happens **outside this repo**. Your MR cannot contain it, which is exactly why the MR has to make it unmissable — see the deploy handoff.

## Which mechanism — three shapes, not two

Work out which shape you have before writing anything. The first is the common case; the other two are legitimate and both create rows from app code at runtime.

### 1. Fixed cadence, same clock time for everyone

One schedule, decided at build time, not keyed to any entity. → **Management command + DevOps crontab.** Everything under "The rule" applies.

### 2. One-off, timed to a business event, per entity

A single execution on a date computed from one entity's data. → **`PeriodicTask.objects.get_or_create(..., one_off=True)`.**

Precedent: `apps/costing/utils.py` — `create_gratuity_calculation_task`, `create_annual_bonus_calculation_task`, each scheduling one recalculation for one person on a computed future date.

### 3. Repeating, but per-entity, with a cadence keyed to that entity

A recurring schedule that exists once **per business entity**, created at runtime, whose cadence or expiry comes from that entity's data. → **`create_or_update_repeating_cron_periodic_task(..., one_off=False)`** (`common/utils.py:2067`).

Precedent: `apps/competencies/management/commands/send_competency_reminder_periodically.py:71-74,89-92` creates one repeating row **per person**, on `day_of_month: "*/7"` (`:66`) for leads and `"*/15"` (`:84`) for peers, with `expires=review_date` on the peer schedule and the person's name in `task_title`.

This shape **cannot** be collapsed into a crontab line. The cadence, the recipient set and the expiry are all per-person and only known at runtime; a crontab entry has nowhere to put them.

### Using the test

> Is the cadence the same for everybody and known at build time? → **case 1**.
> Does it fire once, on a date computed per entity? → **case 2**.
> Does it repeat, but once per entity, on a cadence or expiry from that entity's data? → **case 3**.

Citing a file that uses `PeriodicTask` is not evidence that your case may. Identify which of the three the cited file is first — `apps/costing/utils.py` is case 2 and `send_competency_reminder_periodically.py` is case 3, and both get mis-cited as blanket permission.

The thing that is genuinely never right is **case 1 implemented as a seeded row** — a fixed, everyone-at-once cadence written into a migration or hardcoded at import time.

### Two gotchas in `create_or_update_repeating_cron_periodic_task`

Both are in `common/utils.py:2067`.

- **Despite "repeating" in the name, it defaults to `one_off=True`** (`:2068`). Case 3 only works because the competencies caller passes `one_off=False` explicitly. Omit it and you silently get a single execution.
- **`**task_args` are packaged as one dict**, passed as the task's single positional argument (`args=json.dumps([task_args]) if task_args else []`, `:2098`). The consuming task must take one dict parameter — see `send_periodic_competency_reminder_task(competency_data)` (`apps/competencies/tasks.py:23`) — not unpacked scalars.

---

## Deploy handoff — mandatory when a command needs a schedule

Whenever a new or changed command needs a crontab entry — a new schedule, a changed cadence, or a legacy entry that must be removed or superseded — do **both**:

1. Add the "Ops action required" item to the MR description. Fill in `templates/ops-checklist.md`.
2. Post a matching comment on the GitLab ticket. The MR merges and closes; the ops follow-up can lag behind it, so the ticket is where it stays visible until done.

Never assume a crontab entry exists because the command exists and the MR merged. Verify with ops before relying on the schedule in QA — and if a reminder appears not to be firing after a deploy, this is the first thing to check and the checklist item is what you cite.
