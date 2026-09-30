# Ops Handoff Template

Paste into the MR description under `## Checklist`, and post the same content as a comment on the ticket. Replace every `<...>`; an unfilled placeholder is worse than no item, because it reads as done.

## New schedule

```markdown
- [ ] **Ops action required**: register on the server crontab —
      `<minute> <hour> <dom> <month> <dow> <path>/manage.py <command_name> <flags>`
      (<human-readable cadence>, <dev + stage + prod, or the subset that applies>)
```

## Superseding or removing an existing schedule

```markdown
- [ ] **Ops action required**: remove/disable the legacy crontab entry for `<old_command>` —
      superseded by `<new_command>`
```

## Changed cadence

```markdown
- [ ] **Ops action required**: update the crontab entry for `<command_name>` —
      was `<old schedule>`, now `<new schedule>` (<human-readable cadence>, <environments>)
```

## Worked example

`example_weekly_reminder` and `old_weekly_nudge` below are illustrative names — no such commands exist. Substitute your own.

```markdown
## Checklist
- [ ] Tested locally
- [ ] **Ops action required**: register on the server crontab —
      `0 9 * * 3,5,0 <path>/manage.py example_weekly_reminder`
      (Wed/Fri/Sun 09:00, dev + stage + prod)
- [ ] **Ops action required**: remove/disable the legacy crontab entry for `old_weekly_nudge` —
      superseded by `example_weekly_reminder`
```

Notes:

- State the **environments explicitly**. "All environments" is ambiguous when a reminder should not fire from dev.
- Give the cadence in words next to the cron expression. Nobody should have to parse `3,5,0` to review the MR.
- **One checklist item per crontab line.** Most commands need exactly one.
- **A command should not need several lines that differ only by a flag.** That shape means the schedule's meaning is in the crontab rather than the repo — ERP stores no schedule, so nothing here can record what `--slot 2` is due to do, and a partially-registered set fails silently for whichever invocations ops missed. Put the cadence in a named constant and branch on the date instead; see `django-management-commands` § `add_arguments`.
- Run the invocation verbatim before pasting it. A typo here is a no-op on the server that nobody discovers until someone asks why a reminder never arrived.
