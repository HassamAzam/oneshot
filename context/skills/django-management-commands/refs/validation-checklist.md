# Management Command Validation Checklist

Run this after writing or changing a file under `apps/<app>/management/commands/`. Authoritative specs: `django-management-commands/SKILL.md`, `django-scheduled-jobs/SKILL.md`, and `.claude/rules/backend-python.md`. This file is a check, not a rulebook — read the spec when a line needs depth.

Each item is written so it can be answered by looking at the diff. If an item does not apply, say why rather than skipping it silently.

## Structure

- [ ] `handle()` delegates to `utils.py` or a model method — no query/transform/send logic inline
- [ ] `handle()` body wrapped in `try/except Exception` with `logger.exception(...)`
- [ ] Logger name matches `.claude/rules/backend-python.md` § "Logging — Which Logger and Which Level" — `__name__` for the ERROR/exception path
- [ ] Any INFO line that must survive in prod uses a separate, explicitly-named `getLogger("hrdb")` — **not** `__name__`, which drops INFO silently
- [ ] No `print()` anywhere in the command
- [ ] Command module has a one-line docstring saying what runs it
- [ ] `Command` class has a docstring

## Arguments

- [ ] Choice between `add_arguments` and date-based auto-detection is deliberate, per the SKILL's rule (N distinct invocations → `add_arguments`)
- [ ] Every argument declares `type=`, and `choices=` / `required=` where the domain is closed
- [ ] No argument silently defaulting to a value that changes who gets notified

## Idempotency

- [ ] A second run over the same data is a no-op — there is an explicit guard (`is_completed=False`, `get_or_create`, `update_or_create`, or an equivalent filter)
- [ ] The guard is in the query, not merely implied by the schedule
- [ ] Nothing double-sends if the process dies partway and is re-run

## Celery

- [ ] Mail or heavy compute is handed off via `.delay()` rather than run synchronously in `handle()`
- [ ] The task being called is itself idempotent
- [ ] If the task takes a dict, the caller packages it the way the task expects — see `django-scheduled-jobs` on `create_or_update_repeating_cron_periodic_task` packaging `**task_args` as one positional dict

## Queries

- [ ] Reads on soft-deletable models use `active_objects`, not `.objects` (per `.claude/rules/backend-django.md`)
- [ ] No N+1 across the person/entity loop — `select_related` / `prefetch_related` or a bulk lookup map
- [ ] `bulk_create` / `bulk_update` instead of loop-save

## Tests

- [ ] Test file is `apps/<app>/tests/<command_name>_test.py` — **the `_test.py` suffix is mandatory or the file is never collected**
- [ ] The extracted `utils.py` function is tested directly, not only through `call_command`
- [ ] `.delay()` is mocked and asserted on by argument
- [ ] Empty queryset covered (nobody to notify)
- [ ] Idempotency guard covered (second run is a no-op)
- [ ] Each `add_arguments` branch covered separately

## Scheduling handoff

- [ ] If this command needs to run on a schedule, `django-scheduled-jobs` was read and its deploy checklist applied — a schedule is never created in app code or a migration
- [ ] The MR description carries the "Ops action required" item with the exact `manage.py` invocation and target servers
- [ ] A matching comment exists on the ticket, so the ops step stays visible after the MR closes

## Lint

- [ ] `flake8` and `pylint` clean on every changed `.py` file
- [ ] No inline `#` comments added (per `.claude/rules/backend-python.md` — docstrings instead)
