---
name: erp-ticket-test-data
description: >-
  Phase 3 of ERP ticket testing — create the minimum fresh test data a plan needs on the chosen ERP
  server (dev/stage), safely. Use standalone when the user says "set up test data", "create a test
  increment/leave/expense on stage", "seed data for this scenario", or as the third step invoked by the
  test-erp-ticket orchestrator. Covers Django webshell discovery + rollback, UI-created data, and
  cleanup tracking.
---

# Phase 3 — Test Data Creation

**Goal:** create the minimum fresh data each approved scenario needs, on the chosen server, without corrupting existing records.

**Prerequisite (GATE):** the server is chosen and confirmed (dev/stage) and — for UI-created data — the user is logged in (login handoff is in `erp-ticket-execution`). Confirm the MR is deployed on *that* server before creating anything.

> Shared env (webshell path, token, servers) lives in `test-erp-ticket/SKILL.md`.

## Webshell data (`/admin/webshell/script/<id>/change/`)

- **Discovery first (read-only):** print current state, IDs, and any limit/config tables; snapshot originals so they can be restored. Confirm the exact target record before any write.
- **Non-destructive edge cases:** wrap mutation + read in a transaction and roll back:
  ```python
  from django.db import transaction
  with transaction.atomic():
      # mutate, compute, capture result
      transaction.set_rollback(True)   # nothing persists
  ```
- **Persisted data for UI checks:** create the minimum needed, print exact expected values, offer a restore/cleanup script afterward.
- **`exec()` scope gotchas** (these bite every time):
  - No top-level `def`/`lambda` referencing module-level names — `__globals__` won't see your imports/vars (`NameError`).
  - No comprehensions referencing top-level names in the body — same scope problem.
  - Use plain `for`/`while` loops and accumulate into variables. Avoid `sum(x for x in ...)` over top-level names.
  - Keep scripts idempotent (delete-then-create, `get_or_create`).
- Paste each script for the user to run; ask them to paste the output back.

## UI-created data

- Use an **identifiable marker** (e.g. a comment `QA test #<IID> - <purpose>`) so records are easy to find and clean up.
- Beware **one-shot / hover-only controls** (see `erp-ticket-execution`) — an action may be usable once per record; create a fresh record per repeat.

## Track what you created

List every record created and where (person, IDs, server) so it appears in the report and can be cleaned up. Offer a cleanup/restore step at the end.

Next in the pipeline: `erp-ticket-execution`.
