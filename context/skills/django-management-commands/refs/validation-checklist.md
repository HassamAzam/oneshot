# Management Command Validation Checklist

Run this after writing or changing a file under `apps/<app>/management/commands/`. Authoritative specs: `django-management-commands/SKILL.md`, `django-scheduled-jobs/SKILL.md`, and `.claude/rules/backend-python.md`. This file is a check, not a rulebook — read the spec when a line needs depth.

Two kinds of item here, and the difference matters:

- **Static checks** are answerable by reading the diff.
- **Evidence checks** are answerable only by running something and recording what happened. A tick with no recorded outcome is not a pass — write the number, the output line, or the row count next to it.

If an item does not apply, say why rather than skipping it silently.

## Structure

- [ ] `handle()` delegates to `utils.py` or a model method — no query/transform/send logic inline
- [ ] `handle()` body wrapped in `try/except Exception` with `logger.exception(...)`
- [ ] Logger name matches `.claude/rules/backend-python.md` § "Logging — Which Logger and Which Level" — `__name__` for the ERROR/exception path
- [ ] Any INFO line that must survive in prod uses a separate, explicitly-named `getLogger("hrdb")` — **not** `__name__`, which drops INFO silently
- [ ] No `print()` anywhere in the command
- [ ] Command module has a one-line docstring saying what runs it
- [ ] `Command` class has a docstring

## Arguments

- [ ] Choice between `add_arguments` and date-based auto-detection is deliberate — 78 of 108 commands take no arguments and read `date.today()` themselves; see the SKILL for what the 30 use flags for
- [ ] If a flag selects between variants of the same logic, that is a new pattern here (zero commands use `choices=`) — say so in the MR rather than implying precedent
- [ ] Every argument declares `type=`, plus `required=` where there is no safe default
- [ ] No argument silently defaulting to a value that changes who gets notified

## Idempotency

- [ ] There is an explicit guard (`is_completed=False`, `get_or_create`, `update_or_create`, or an equivalent filter)
- [ ] The guard is in the query, not merely implied by the schedule
- [ ] Nothing double-sends if the process dies partway and is re-run
- [ ] **Demonstrated, not asserted** — see Evidence below

## Celery

- [ ] Mail or heavy compute is handed off via `.delay()` rather than run synchronously in `handle()`
- [ ] The task being called is itself idempotent
- [ ] If the task takes a dict, the caller packages it the way the task expects — see `django-scheduled-jobs` on `create_or_update_repeating_cron_periodic_task` packaging `**task_args` as one positional dict

## Queries

- [ ] Reads on soft-deletable models use `active_objects`, not `.objects` (per `.claude/rules/backend-django.md`)
- [ ] No N+1 across the person/entity loop — `select_related` / `prefetch_related` or a bulk lookup map
- [ ] `bulk_create` / `bulk_update` instead of loop-save

## Tests

- [ ] Test file is named `apps/<app>/tests/<command_name>_test.py`
- [ ] **Its test class is imported in `apps/<app>/tests/__init__.py`** — the import is what collects the test; the runner keeps Django's default `test*.py` pattern, so the filename alone runs nothing. Name the class and the line you added it on; a correct suffix is not evidence of collection
- [ ] The extracted `utils.py` function is tested directly, not only through `call_command`
- [ ] `.delay()` is mocked and asserted on by argument
- [ ] Empty queryset covered (nobody to notify)
- [ ] Idempotency guard covered (second run is a no-op)
- [ ] Each `add_arguments` branch covered separately

## Evidence — run it, do not just read it

Everything above can be satisfied by a command that has never executed. These cannot. Record the actual output beside each one.

- [ ] **`python manage.py <command> --help` exits 0.** Catches a broken `add_arguments` before ops discovers it on a server. Record the flags it printed.
- [ ] **Ran once against local data.** Record what changed — rows touched, recipients, or "nothing, queryset was empty". If nothing changed and you expected something to, the command is not working.
- [ ] **Ran a second time immediately.** Record that nothing changed. This is the only thing that actually establishes idempotency; the guard in the query is just the mechanism.
- [ ] **Ran the test and saw it execute.** Paste the runner line naming your test class. This is the sole defence against the `__init__.py` collection trap — a written test that was never collected looks identical to a passing one.
- [ ] **Exercised the failure path at least once** (bad input, or temporarily raise inside the util) and confirmed the `logger.exception(...)` line appeared, under the logger name you chose. `send_competency_deadline_reminder.py` has no handler at all and nobody noticed for as long as it has been live — an unverified handler is the same thing with extra steps.
- [ ] **If scheduled:** the exact `manage.py` invocation written in the ops checklist item was run verbatim and succeeded. A typo in that line is a silent no-op on the server.

## Scheduling handoff

- [ ] If this command needs to run on a schedule, `django-scheduled-jobs` was read and the shape identified as case 1, 2 or 3 — state which
- [ ] No `PeriodicTask`/`CrontabSchedule` row is seeded in a data migration (absolute)
- [ ] If a row is created from app code, it is per-entity (case 2 or 3) and the reason it cannot be a crontab line is stated
- [ ] The MR description carries the "Ops action required" item with the exact `manage.py` invocation and target servers
- [ ] A matching comment exists on the ticket, so the ops step stays visible after the MR closes

## Lint

- [ ] `flake8` and `pylint` clean on every changed `.py` file — record the exit status, not the intention
- [ ] No inline `#` comments added (per `.claude/rules/backend-python.md` — docstrings instead)
