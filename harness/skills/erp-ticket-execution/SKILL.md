---
name: erp-ticket-execution
description: >-
  Phase 4 of ERP ticket testing — run the approved test scenarios on the chosen ERP server (dev/stage),
  one at a time, with a screenshot each. Use standalone when the user says "execute the test cases",
  "run these scenarios on stage", "drive the UI for this ticket", or as the fourth step invoked by the
  test-erp-ticket orchestrator. Covers manual browser login, Claude-in-Chrome/Playwright fallback,
  hover/one-shot control gotchas, and API/webshell fallback.
---

# Phase 4 — Test Execution

**Goal:** run each approved scenario, capture evidence, record Expected vs Actual. Default path is the browser; fall back to API/webshell where the browser can't reach.

> Shared env/servers/token live in `test-erp-ticket/SKILL.md`.

## Server + login handoff (GATE)

- **Ask which server** (dev/stage) — never assume. Confirm the MR is deployed *there*.
- **Navigate** to it: dev = `https://dev-workstream.arbisoft.com` · stage = `https://workstream-staging.arbisoft.com`.
- **Which browser tool:** try `Claude in Chrome` first. Internal arbisoft domains often reject it ("Permission denied for this domain"); if so, fall back to Playwright / Claude Preview. Don't fight a blocked tool — switch.
- **Login is manual — never enter credentials.** Open the login page, tell the user to log in themselves, then STOP and wait for them to confirm they're logged in and on the right page. Never store, request, or type usernames/passwords.

## Run scenarios one at a time (in confirmed plan order)

0. **Hard-refresh first.** Before testing (and after any **Re-Generate Data** / data change), do a **cache-bypassing reload** of the page — re-`navigate` to the URL (or Cmd/Ctrl+Shift+R) so you're reading freshly generated data, not a stale cached view. Costing/PnL pages especially cache aggressively.
1. State which scenario you're about to run and the expected result (from the ticket, not the code).
2. Drive the UI: navigate, fill, click, read the result.
3. **Screenshot the final state.** Locally-driven browser (Playwright/Preview): save to `/tmp/erp-<IID>/<n>-<short-scenario>.png` (create the dir once at run start). `Claude in Chrome`: `save_to_disk` images are held browser-side and do **not** persist to `/tmp/erp-<IID>/` — treat the inline transcript images as evidence and reference those (don't cite a `/tmp` path you didn't write).
4. Record Expected vs Actual and a status before starting the next scenario.

- **Blocked step** (tool can't do it, needs data you can't create in-UI, or the check isn't observable in-browser): **pause and ask the user** to perform it manually, then resume once they confirm. Never skip silently or guess an outcome.
- **Hover-only / one-shot controls:** row action icons (send/edit/delete) are often revealed only on hover and absent from the DOM until then, so `find`/a11y queries won't see them — hover the row first, and if it still won't trigger, **reload the page** to re-render it. Some actions are one-shot (e.g. an increment email can be sent only once per record) — the control disappears after use, so create a fresh record for a repeat run rather than assuming it's broken.
- **Session care:** if the session drops or a page 401s/redirects to login mid-run, stop and ask the user to log in again.

## API execution (preferred for API tickets)

- `curl` with `-w "\n--- HTTP %{http_code} ---\n"` so the status shows (plain `-sS` hides it). Or a `python3` + `urllib` harness for GET→transform→PATCH round-trips.
- API auth: DRF token — header `Authorization: Token <token>` (NOT `Bearer`). Mint one via webshell: `Token.objects.get_or_create(user=Person.objects.get(id=<pid>).user)[0].key`.
- Optimistic-lock endpoints need the *current* `modified_at` — GET first. Validation usually fires before lock/scoping checks — negatives often 400 regardless of `modified_at`.

## Fallbacks & safety

- If **every** browser tool is blocked on the domain, read the frontend logic from the repo to derive expected behavior and hand the user precise UI steps to run.
- **Destructive vs non-destructive:** negatives that return 4xx roll back (safe). Positives/valid writes and "200-but-ignored" cases mutate data — flag them and confirm scope before running.

Next in the pipeline: `erp-ticket-reporting`.
