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

```markdown
## Checklist
- [ ] Tested locally
- [ ] **Ops action required**: register on the server crontab —
      `0 9 * * 3,5,0 <path>/manage.py notify_project_logs_weekly_reminder --reminder <N>`
      (Wed/Fri/Sun 09:00, dev + stage + prod)
- [ ] **Ops action required**: remove/disable the legacy crontab entry for `old_weekly_nudge` —
      superseded by `notify_project_logs_weekly_reminder`
```

Notes:

- State the **environments explicitly**. "All environments" is ambiguous when a reminder should not fire from dev.
- One checklist item per crontab line. Three reminder slots passing `--reminder 1|2|3` are three lines, and ops needs all three.
- Give the cadence in words next to the cron expression. Nobody should have to parse `3,5,0` to review the MR.
