---
name: erp-ticket-test-plan
description: >-
  Phase 2 of ERP ticket testing — turn a ticket's requirements into a concrete list of test scenarios,
  then WAIT for the user's go-ahead. Use standalone when the user says "plan test cases for this ticket",
  "what scenarios should we test", "make a test plan", or as the second step invoked by the
  test-erp-ticket orchestrator. Covers happy/negative/edge/boundary/side-effect scenarios with expected
  values derived from business logic.
---

# Phase 2 — Test Plan Creation

**Goal:** turn the requirements understanding (Phase 1) into a concrete scenario list, then STOP for the user's go-ahead. Do NOT create data or execute here.

> If run standalone without Phase 1's output, first establish the ticket's expected behavior (fetch it or ask the user). Shared context lives in `test-erp-ticket/SKILL.md`.

## Plan the scenarios

Cover every category:
- **Happy path** — the ticket's primary repro / acceptance case.
- **Negative** — invalid input, unauthorized, missing prerequisites.
- **Edge** — feature interactions, unusual-but-valid states.
- **Boundary** — limits, min/max, field lengths, zero/empty.
- **Side-effects / regression** — what else touches this code path; confirm no lost features vs the current version.

**Derive every "Expected" from the ticket's business logic, NOT the code's output.** If the expected value comes from the same code path you are testing, a systematic bug passes silently.

## Present + GATE

Show the full plan as a numbered list (Type · Scenario · Expected). Then:

> **GATE — WAIT for explicit go-ahead.** Do not create data or execute until the user confirms. If they add/drop/modify scenarios, update and re-confirm.

Also surface here: which scenarios are UI-driven vs API/webshell, and which **persist data / send real emails** (destructive) vs which roll back (safe).

Next in the pipeline: `erp-ticket-test-data`.
