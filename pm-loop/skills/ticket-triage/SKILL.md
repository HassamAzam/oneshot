---
name: ticket-triage
description: Triage incoming Plane tickets into quick-fix, groom, needs-info, or scope, and route every clarity-passed ticket on arbisoft/erp by delivery zone — green to Oneshot (ai), yellow to Oneshot behind characterization tests (ai-tests), red to people (human). Runs twice daily via cron.
---

# Ticket Triage (Loop A)

Specs: `docs/superpowers/specs/2026-07-20-triage-loop-a-design.md`,
`docs/superpowers/specs/2026-09-30-single-board-zones-design.md`

Run from: `~/Documents/ai/claude/Workstream/triage-cron`
(a worktree of the erp repo on `triage/board-router`; the code is not on dev yet).

The zone map and label allow-list are read from the erp repo's **origin/dev**
(`.claude/zones.json`, `.claude/labels.json`). Until they are merged there,
every ticket routes `human` with the reason `zone map unavailable` — expected,
not a failure.

Requires `PLANE_API_KEY` and `TRIAGE_SENTINEL_ISSUE_ID`.
`TRIAGE_SLACK_WEBHOOK` is optional — without it the digest only prints.

## Dry run (manual only)

The cron runs live. For a manual trial, `TRIAGE_DRY_RUN=1` makes `apply`
write nothing to Plane and report the payload it would have sent. Decide and
call apply exactly as you would on a live run — the gate is in the code, not
in your judgement. Pass `--dry-run` to `digest` too so the log is labelled
honestly.

## Run procedure

1. `python3 -m scripts.triage.cli selftest`
   If `selftest_ok` is false — **abort the run**, send the digest with the self-test failure, stop. Do not triage anything.

2. `python3 -m scripts.triage.cli queue` (add `--backfill` for a cold start)

   The queue excludes anything outside Incoming / Needs Clarity. No
   swimlane is exempt — accessibility tickets are triaged like any other.
   Do not second-guess the queue; triage every item it returns.

3. For each item in the queue, decide an outcome using the decision rule below,
   then — for `groom` and `quick-fix` only — a route using the routing rule.

4. Apply the whole run in one call:

   ```
   python3 -m scripts.triage.cli apply-batch --decisions '[
     {"issue": "<uuid>", "outcome": "groom", "route": "ai", "size": "S",
      "kind": "bug", "areas": ["training"], "design": false,
      "reasons": ["frontend-only label fix", "AC clear"]},
     {"issue": "<uuid>", "outcome": "needs-info", "comment": "<p>...</p>"}
   ]'
   ```

   On the Friday 1700 run add `"suppress_client_comment": true` to each decision.
   Use the single-ticket `apply` only for manual one-offs; `apply-batch` is
   what enforces the rails.

   It returns `{results, errors}` — feed both straight into the digest.

5. `python3 -m scripts.triage.cli digest --results '<json>' --errors '<json>' --selftest-ok`

   Pass the `results` and `errors` arrays from step 4 verbatim. Do not edit,
   summarise, or drop entries — the digest is the run's record.

6. `python3 -m scripts.triage.cli misroutes` — routing decisions people have
   since overruled (a person removed `AI` from a routed issue or added it to a
   human one, moved the issue off arbisoft/erp, or it closed without Oneshot's
   `Merged`). Print the JSON as the last thing in the run. Report it; never
   re-route anything yourself. `Needs Human` is NOT a misroute and is never
   counted, and a yellow change issue waiting without `Loop` is not one either.

## Decision rule

Primary test: **can acceptance criteria be written without guessing?**

- No, and the gap is client-side (no repro steps, no expected-vs-actual, ambiguous screen) → `needs-info`
- No, but information is complete and the solution space is wide (cross-module, needs a product call) → `scope`
- Yes, and it matches the quick-fix whitelist → `quick-fix`
- Yes, otherwise → `groom`

Judge clarity first, and only clarity, for the outcome. Size belongs to the
routing rule, which runs only once the ticket is understood.

## Routing rule (groom / quick-fix only)

Every clarity-passed ticket is groomed onto **arbisoft/erp**. The route decides
whether, and how, Oneshot takes it. Grooming (Loop B) reads the route from the
marker and labels the issue.

| Route | Zone | What grooming does |
|---|---|---|
| `ai` | green | labels `AI` + `Loop` — Oneshot starts at once |
| `ai-tests` | yellow | a human-owned `Characterization Tests` issue, plus the change issue with `AI` + `Review` and **no** `Loop` until the tests merge |
| `human` | red, or any rail | assigned to people, as before |

Propose these fields per decision:

| Field | Values | How to judge it |
|---|---|---|
| `size` | `XS` / `S` / `M` / `L` / `XL` | XS = copy or config. S = one layer, ≤3 files, no migration. M = both layers or a migration, one module. L = several modules, a new workflow, or a data change to existing records. XL = a project, not a ticket |
| `kind` | `bug` / `feature` / `change` / `chore` / `tech_debt` | bug = something that worked or should work is wrong. feature = new behaviour. change = an existing flow must behave differently. chore = copy, config, cleanup. tech_debt = refactor or performance, no behaviour change |
| `areas` | area names from `.claude/zones.json` | Every area the change would touch — backend AND frontend. Name them from the map's `areas[].name`; include `shared_frontend` when a shared util or component would change. Leave empty rather than guess |
| `design` | `true` / `false` | true when the ticket asks for a new screen, a new UI element or a visual change with no mockup attached. Oneshot's design phase fires on it |
| `route` | `ai` / `human` | Propose `ai` when the ticket is automatable in principle: observable in the app, one module, acceptance criteria clear. Code turns `ai` into `ai-tests` or `human` by zone. Propose `human` when it needs a product call, depends on data only production has, or you are not confident |
| `reasons` | ≤4 short strings | Why, in words the PM can check |

When unsure, `human` — a wrong `ai` costs an unattended run; a wrong `human`
costs nothing. To see which areas and zone a file falls in:
`python3 .claude/scripts/check_zones.py --explain <path>` (in any erp checkout).

Oneshot's track record, if present: `$ONESHOT_HOME/state/memory/index.jsonl`
(default `ONESHOT_HOME` is `~/Documents/ai/claude/oneshot`)
has one line per completed run with its `modules` and `verdict`. A module whose
runs keep ending unmerged is a reason to propose `human`. Read it once per run;
if it is absent or empty, skip it.

### Rails enforced in code (you cannot override them)

`apply-batch` computes the zone as the MOST severe over your `areas` plus every
area whose keywords the ticket text names — a keyword can only raise the zone,
and no area at all means the map's default (yellow). It then moves a ticket to
`human` — never towards Oneshot — when:

- the zone map on origin/dev cannot be read
- `size` is missing or above `ai_max_size` in `.claude/labels.json` (M)
- Plane priority is `urgent`
- the text names an integration Oneshot cannot verify locally (the map's
  `external_integrations`: Odoo, Google Calendar, email, OAuth, ListenTool,
  cron/Celery jobs)
- the zone is red
- no `route` is given

`needs-info` and `scope` are always routed `pm`: they go back to the client or
the PM, never to a board. The marker records the final route, zone and areas;
the digest shows them, with the reason when code overruled you.

## Quick-fix whitelist

Only these qualify:

- copy / label text change
- validation message change
- missing filter option on an existing filter set
- permission label change

Never quick-fix anything touching a red area of the zone map (payroll, auth, permissions, …).

`quick-fix` is a clarity outcome only — it no longer means "send to AI". Whether
Oneshot takes it is decided by `route`, exactly as for `groom`.

## Asking the client

Before writing a `needs-info` comment:

- Search `apps/` and existing GitLab issues for the answer. Maximum 3 searches.
- Anything findable in the repo is **not** asked.
- Maximum 3 questions, numbered.
- Read attachments only when the description is under 80 characters.

## Rails enforced in code, not by you

`apply-batch` will override your decision when it has to. This is expected —
do not work around it:

| Rail | Effect |
|---|---|
| Already triaged, creator silent since | ticket skipped, nothing written |
| 2 needs-info rounds already spent | escalated to `scope`, question dropped |
| `quick-fix` on any red area (or with the map unreadable) | downgraded to `groom` |
| Client comment with more than 3 `?` | refused, recorded as an error |
| Client comment on any outcome but `needs-info` | refused |
| More than 8 client comments in one run | refused past the cap |

A ticket that errors does not stop the run; the rest still apply.

## Recheck

A ticket re-enters the queue only when its last outcome was `needs-info` and the ticket creator has replied since. Tickets already groomed or scoped are never pulled back by a client comment — a human owns those.

## Never

- Remove or edit an existing marker
- Post a client comment before the marker and state writes have succeeded (the CLI enforces the order)
- Create GitLab issues — that is Loop B
- Write code — that is Loop C
