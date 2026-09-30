---
name: ticket-grooming
description: Groom Plane tickets into GitLab issues on arbisoft/erp — single, batch, one-shot, or MR-to-ticket — via groom.py, which applies the triage route and zone (green → AI + Loop for Oneshot, yellow → characterization-tests issue first, red → people) and attaches the original documents.
---

# Ticket Grooming (Loop B)

`groom.py` owns every rule: eligibility and duplicate checks, route, zone,
labels, milestone, assignee, mandatory acceptance criteria, documents, the
Plane back-link and the sprint sheet. **You write the title and the body; you
never call an API directly.** Run it as
`python3 ~/.claude/scripts/groom.py …` (allow-listed, no prompt).

## Flow: 3 calls per ticket

1. **Resolve** — `groom.py resolve WORKSTREAMRE-230` (several IDs in one call for a batch).
   `eligible: false` → report `skip_reason`, stop that ticket.
2. **Context** — `groom.py context "kw1" "kw2" "kw3"`. Pick 2–5 lines for
   `## Previous Context`; note their iids. An `(open)` issue asking for the
   **same thing** → stop, report "possible duplicate of #N", create nothing.
3. **Create** — body as a quoted heredoc, in the same call:

```bash
python3 ~/.claude/scripts/groom.py create --id WORKSTREAMRE-230 \
  --title "<title>" --from-issues 8602,8577 <<'GROOM_BODY'
<body>
GROOM_BODY
```

**Layers are Jev's call, not yours.** `resolve` shows `layers` (backend /
frontend / migration, with probabilities) decided by Jev from the ticket's title
and description; `create` uses the same answer for the Backend/Frontend labels and
the mandatory ACs, and records it under `## Routing`. Oneshot loads subagents and
skills from those labels. If `layers.source` is `fallback`, Jev was unreachable and
every layer was kept — report it. Never try to override layers.
`--kind` / `--size` only when `create` says the marker lacks them (use triage's rubric).
Unsure of anything? Add `--dry-run` first — it writes nothing.

## The body you write

```markdown
## Previous Context
- [#<iid> — <title>](<url>) (closed <YYYY-MM-DD>)

## Current State
<from the ticket>

## Future Intended State
<from the ticket>

## Acceptance Criteria
- [ ] <observable outcome: a value, message, element or behaviour on a named screen or API>
- [ ] On <screen> with dark theme on, all text and controls are readable and nothing overlaps   ← when `layers` has frontend; name the screen

## Impacted Modules / Teams
<areas, in words>
```

When `resolve` shows `route` **`ai` or `ai-tests`**, add after `## Current State`:

```markdown
## Kind
## Where it happens        (route/screen · how to get there · who sees it)
## Steps to reproduce      (bugs only: numbered steps, Expected, Actual, account/data)
## Linked modules
```

and on **`ai-tests`**, end the body with `<!-- tests-scope -->` followed by
2–5 bullets naming the current behaviour the characterization tests must pin.

Write only what the ticket, its comments or its documents state. A line you
would have to guess is `unknown` — Oneshot treats an explicit unknown correctly
and a wrong claim as fact.

`create` adds, so you must not: Attachments, References, Requested By, Plane
Ticket, Routing, and the backend AC (API response times, human route only). It
refuses frontend work without the dark-theme AC naming its screen, and filler ACs
("no regressions", "works as expected") on AI routes — rewrite them as observable
outcomes. `unlabelled` in the output lists areas or swimlanes that have no GitLab
label: report them.

## Reading the result

| In the output | Do |
|---|---|
| `skipped` | Report the reason. Nothing was written. |
| `error` | Stop that ticket and report it verbatim. Never work around a label or network refusal; never sleep and retry — the script already retried. |
| `documents.private` | Private Google file: fetch with the Google Drive connector (`download_file_content`, export PDF for docs/slides, XLSX for sheets), save to `/tmp/pmloop/`, then `groom.py attach --issue <iid> <file>`. If the connector cannot open it, leave the ⚠️ link `create` wrote and report it. |
| `documents.failed` | Report each. |
| `sheet: FAILED …` | Report it with the rerun command it prints. The issue exists. |
| `plane.backlink: FAILED` | Report it — without the back-link the duplicate check cannot see this ticket. |

## Other modes

- **Batch** — one `resolve` for all IDs; one call running every ticket's search
  (`groom.py context … ; echo '---' ; groom.py context …`); then one `create` per ticket, sequentially. N+2 calls.
- **One-shot** (no Plane ticket) — `create --title … --kind … --size …`; always the
  human route. To send work to Oneshot, file it in Plane and let triage route it.
  `--assignee <gitlab-username>` to assign someone other than the default.
- **MR-to-ticket** — `groom.py mr <iid>` for the summary, then
  `create --mr <iid> --title … --kind … --size …` with a body of `## Summary`
  (PR-Bot description bullets), `## Changes` (walkthrough bullets), `## Related MR`.
  The MR author is assigned and the MR gets `Closes #<issue>` prepended.

## Terminal output

```
| Plane            | Title    | Route    | Zone   | GitLab        | Sheet | Documents                |
|------------------|----------|----------|--------|---------------|-------|--------------------------|
| WORKSTREAMRE-230 | Title... | ai-tests | yellow | #8812 ← #8811 | ✓     | 2 attached, ⚠️ 1 private |
```

Then list skipped tickets with reasons, and every failed or private document.
