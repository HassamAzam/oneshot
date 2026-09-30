---
name: ticket-grooming
description: Groom Plane tickets into GitLab issues on arbisoft/erp — single, batch, or one-shot — via groom.py, which applies the triage route and zone (green → AI + Loop for Oneshot, yellow → characterization-tests issue first, red → people) and attaches the original documents. For an MR with no ticket, use mr-to-ticket.
---

# Ticket Grooming (Loop B)

1. **Code owns the rules; you own the words.** `groom.py` decides eligibility,
   duplicates, route, zone, labels, layers (Jev), milestone, assignee, mandatory ACs,
   documents, back-link and sheet. You write the title and the body. Never call an API.
2. **Never guess.** Every line comes from the ticket, its comments or its documents.
   What you'd have to guess is `unknown` — Oneshot handles an unknown, not a wrong claim.
3. **Report, don't work around.** A refusal or failure is reported verbatim; the script
   already retried. Ambiguous ticket? Read `hard-cases.md`.

Run as `python3 ~/.claude/scripts/groom.py …` (allow-listed).

## Flow — 3 calls per ticket

1. `groom.py resolve WORKSTREAMRE-230` — `eligible: false` → report `skip_reason`, stop.
   Note `route` and `layers` (Jev's backend / frontend / migration call).
2. `groom.py context "kw1" "kw2" "kw3"` — pick 2–5 lines for Previous Context.
   An `(open)` line asking for the same outcome → stop: "possible duplicate of #N".
3. `groom.py create`, body in the same call:
   ```bash
   python3 ~/.claude/scripts/groom.py create --id WORKSTREAMRE-230 --title "<title>" \
     --from-issues <context iids> <<'GROOM_BODY'
   ## Previous Context
   - [#<iid> — <title>](<url>) (closed <YYYY-MM-DD>)

   ## Current State
   ## Future Intended State
   ## Acceptance Criteria
   - [ ] <observable outcome: a value, message, element or behaviour on a named screen or API>
   - [ ] On <screen> with dark theme on, all text and controls are readable and nothing overlaps   ← only if layers has frontend
   ## Impacted Modules / Teams
   GROOM_BODY
   ```
   On route `ai` / `ai-tests`, add the sections in `templates/ai-sections.md` after Current State.
   `--kind` / `--size` only when `create` asks for them. `--dry-run` writes nothing.

**Labels apply automatically, with two exceptions.** `create` stops with "check with the user
first" for a label not yet on GitLab, or one flagged in `ask_first` (`Opensource`, `Plane team`:
they move work between streams). Ask about just that label, then rerun with `--confirm-labels "<label>"`.

`create` adds Attachments, References, Requested By, Plane Ticket, Routing and the backend AC itself.

## Reading the result

| Output | Do |
|---|---|
| `skipped` / `error` | Report verbatim; nothing (more) was written |
| `layers.source: fallback` | Report: Jev was unreachable, every layer was kept |
| `documents.private` | Fetch with the Google Drive connector (`download_file_content`: PDF for docs/slides, XLSX for sheets) to `/tmp/pmloop/`, then `groom.py attach --issue <iid> <file>`; if it can't open it, report the ⚠️ link |
| `documents.failed`, `unlabelled` | Report each |
| `sheet: FAILED`, `plane.backlink: FAILED` | Report with the rerun command; the issue exists |

**Batch:** one `resolve` for all IDs, one call for all `context` searches, then one `create` per ticket.
**One-shot** (no Plane ticket): `create --title … --kind … --size …`, always the human route.

## Before you finish

- [ ] Every sentence in each body traces to the ticket, a comment or an attached document
- [ ] Guesses are written as `unknown`, not filled in
- [ ] Context was checked for an open duplicate
- [ ] Any new or `ask_first` label was confirmed with the user, never passed on your own
- [ ] Every skipped ticket, error, fallback, failed or private document and unlabelled item is reported
- [ ] One row per ticket: `| Plane | Title | Route | Zone | GitLab | Sheet | Documents |`
