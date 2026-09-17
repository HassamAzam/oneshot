---
name: erp-ticket-test-plan
description: >-
  Phase 2 of ERP ticket testing — turn a ticket's requirements into a concrete list of test scenarios,
  WAIT for the user's go-ahead, and revise the list when feedback comes back instead of a go-ahead.
  Use standalone when the user says "plan test cases for this ticket", "what scenarios should we test",
  "make a test plan", "add these edge cases to the plan", "update the test plan with my feedback",
  "revise the scenarios", or as the second step invoked by the test-erp-ticket orchestrator. Covers
  happy/negative/edge/boundary/side-effects scenarios with expected values derived from business logic.
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

## Revising the plan after feedback

When the reply to the GATE is anything other than a go-ahead, treat it as edits to the scenario list. Append new scenarios; never renumber or rewrite existing ones unless asked.

**1. A verdict is not a scenario.**
Discard any line carrying no testable content: `Disapproved`, `Approved`, `Rejected`, `Not approving`, `Needs work`, greetings, `@mentions`, headings, `---`, blank lines, and closing remarks ("fix these and I'll approve"). A line becomes a scenario only if it names something a tester can execute and observe. If a line is ambiguous, ask — never silently drop it, never silently promote it.

> Real failure: a reply opening with the single word "Disapproved" became `Verify that Disapproved`, Expected the verdict should be ignored and it should not be added as a separate test case.

**2. Apply the "Verify that" stem exactly once.**
Feedback usually arrives already phrased as scenarios. Before adding a line: strip leading list markers (`-`, `*`, `•`, `1.`, `1)`), then strip any leading stem (`Verify that`, `Verify`, `Check that`, `Ensure that`, `Confirm that`, `Validate that` — case-insensitive), then apply one canonical `Verify that`. Assert the text after the stem does not itself begin with another stem. The result must never read `Verify that - Verify that …` or `Verify that Verify …`.

**3. Every added scenario needs its own Expected.**
A restatement is not an Expected. Banned: "Matches the QA-reported edge case: `<scenario>`" (the string an append-only gate fills in for you), "As described by the user", "See scenario", or any paraphrase of the scenario text.

The phase's core rule applies unchanged: derive the Expected from the ticket's business logic — not from the scenario's own wording, and not from the code. State both:
- **the observable** — the value on screen / in the response / in the DB, with the concrete number where one is known
- **the failure condition** — the specific observation that makes it FAIL

Feedback scenarios usually carry a `since` / `because` clause naming the mechanism at risk. Convert that clause into the failure mode.

```
Scenario: Verify that a live refresh while row N is focused leaves the focused row
          showing the SAME record, and Enter navigates to that record's own target
          (guards against index-keyed row reuse).

Expected: After the refresh the focused row renders the same title, detail and due
          date as before, and Enter navigates to that record's URL. If the row's
          content changed while focus stayed put, this FAILS.
```

If a line genuinely implies no observable outcome, ask for the pass condition rather than writing a placeholder.

**4. Classify every added scenario like the rest of the plan.**
Added scenarios are not exempt from the labelling the original plan carries: assign a Type from the five under "Plan the scenarios" — happy / negative / edge / boundary / **side-effects / regression** — and carry the UI-vs-API/webshell and destructive-vs-safe labels described under "Present + GATE".

Anything that would invalidate other scenarios if it failed — wrong server, wrong page version, wrong permission group, defect not reproducible pre-fix — is a side-effects / regression scenario that must run FIRST, not last.

This labelling holds for the plan you present in chat. It does **not** survive an append-only external gate, which tags every case it creates `boundary` / `medium` blast uniformly, on the reasoning that free text cannot safely imply either. So if a Type matters downstream, say it inside the scenario line's own words — the structured field will read `boundary` no matter what you intended.

**5. Re-confirm with a diff, then re-gate.**
Show count before → after, the numbers added, any line discarded under rule 1 and why, and confirmation that the existing scenarios are unchanged. Then run the GATE again.

> **If the plan feeds an append-only external gate** (e.g. a Oneshot "Test cases to be verified" list, where each line of a reply becomes a case that cannot later be edited or deleted by commenting): compose the reply as bare scenario lines only — no verdict word, no bullets, no sign-off — and carry the Expected inside each line. A comment cannot set the Expected field at all: the gate **always** overwrites it with a restatement of the line, so the only place your Expected survives is inside the line's own text. Corrections go to the run owner directly; a comment asking for a deletion only creates another case.

Next in the pipeline: `erp-ticket-test-data`.
