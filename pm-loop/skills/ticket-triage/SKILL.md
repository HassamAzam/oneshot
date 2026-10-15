---
name: ticket-triage
description: Triage incoming Plane tickets into quick-fix, groom, needs-info, or scope, and route every clarity-passed ticket on arbisoft/erp by delivery zone — green to Oneshot (ai), yellow to Oneshot behind characterization tests (ai-tests), red to people (human). Runs twice daily via cron.
---

# Ticket Triage (Loop A)

Run from `~/Documents/ai/claude/Workstream/triage-cron` (erp repo, `triage/board-router`).
Design: `docs/superpowers/specs/2026-09-30-single-board-zones-design.md`.
Needs `PLANE_API_KEY`, `TRIAGE_SENTINEL_ISSUE_ID`; `TRIAGE_SLACK_WEBHOOK` optional.

**You judge clarity and propose a route; code enforces every rail.** When code
overrules you, the digest says why — never work around it (`scripts/triage/route.py`, `run.py`).

## Run

1. `python3 -m scripts.triage.cli selftest` — if `selftest_ok` is false, send the digest with the failure and stop.
2. `python3 -m scripts.triage.cli queue` (`--backfill` on a cold start). Triage every item it returns.
3. Decide each item (below), then apply the whole run once:
   ```
   python3 -m scripts.triage.cli apply-batch --decisions '[
     {"issue": "<uuid>", "outcome": "groom", "route": "ai", "size": "S", "kind": "bug",
      "areas": ["training"], "design": false, "reasons": ["frontend-only label fix"]},
     {"issue": "<uuid>", "outcome": "needs-info", "comment": "<p>1. …</p>"}]'
   ```
   Friday 17:00 run: add `"suppress_client_comment": true` to each decision.
4. `python3 -m scripts.triage.cli digest --results '<json>' --errors '<json>' --selftest-ok` — pass both arrays verbatim.
5. `python3 -m scripts.triage.cli misroutes` — print it last; report, never re-route.

Manual trial: `TRIAGE_DRY_RUN=1`, and `--dry-run` on `digest`.

## Decide

**Outcome — can acceptance criteria be written without guessing?**

| Answer | Outcome |
|---|---|
| No — client-side gap (no repro, no expected vs actual, ambiguous screen) | `needs-info` |
| No — information complete, solution space wide (cross-module, product call) | `scope` |
| Yes — copy/label text, validation message, missing filter option, permission label | `quick-fix` |
| Yes — anything else | `groom` |

**Route (groom / quick-fix only)** — propose `ai` when the ticket is observable in
the app, one module, and its ACs are clear; else `human`. When unsure, `human`: a
wrong `ai` costs an unattended run, a wrong `human` costs nothing. Code turns `ai`
into `ai-tests` (yellow) or `human` (red, size > M, urgent, external integration).

| Field | Values |
|---|---|
| `size` | XS copy/config · S one layer, ≤3 files, no migration · M both layers or a migration, one module · L several modules or a data change · XL a project |
| `kind` | `bug` broken · `feature` new · `change` existing flow must differ · `chore` copy/config/cleanup · `tech_debt` refactor, no behaviour change |
| `areas` | names from `.claude/zones.json`, backend and frontend; `shared_frontend` for shared utils. Empty beats a guess. Check a path: `python3 -m scripts.triage.cli explain <path>` |
| `design` | `true` for a new screen, element or visual change with no mockup |
| `reasons` | ≤4, in words the PM can check |

## Asking the client (`needs-info`)

Ask only what the repo and past issues can't answer: search first
(`python3 ~/.claude/scripts/groom.py context "kw1" "kw2"`, and `apps/`), at most 3 searches,
at most 3 numbered questions. Read attachments only when the description is under 80 characters.

## Before you finish

- [ ] Every queue item has a decision, or appears in `errors`
- [ ] Every `needs-info` question is one the repo couldn't answer
- [ ] The digest was sent with `results` and `errors` unedited
- [ ] `misroutes` was printed last
