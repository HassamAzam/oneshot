---
name: erp-ticket-test-plan
description: >-
  Phase 2 of ERP ticket testing — turn a ticket's requirements into a concrete list of test scenarios,
  WAIT for the user's go-ahead, and extend the list when feedback comes back instead of a go-ahead.
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

When the reply to the GATE is anything other than a go-ahead, read the whole reply first and work out what the reviewer is actually asking for. The reply is raw material, not a list of lines to paste in. Turn what it contains into proper test cases, then append those to the existing list — existing scenarios keep their ids and their wording.

**1. Classify every line before acting on any of it.**
Each line is one of three things:

- **Scenario** — names something a tester can execute and observe. Author it (rule 2) and append it.
- **Instruction** — tells you to change a case that is already in the list: `TC-21 is junk — please delete it`, `merge 3 and 4`, `the Expected on TC-07 is wrong, it should be X`. Handle it under rule 5. It is never appended as a new case.
- **Feedback comment** — no testable content and no instruction: `Disapproved`, `Approved`, `Rejected`, `Not approving`, `Needs work`, greetings, `@mentions`, headings, `---`, blank lines, closing remarks ("fix these and I'll approve"). Discard it.

A line can be two at once — `TC-21 is junk, instead verify that the filter survives a refresh` is an instruction *and* a scenario; split it and handle each half. If a line is ambiguous, ask — never silently drop it, never silently promote it.

> Real failures: a reply opening with the single word "Disapproved" became `Verify that Disapproved`, Expected `Matches the QA-reported edge case: Disapproved`. Pasted in unread, `TC-21 is junk — please delete it` becomes the case `Verify that TC-21 is junk — please delete it` — and TC-21 is still in the list.

**2. Author each feedback scenario into a real case, then append it.**
The reviewer's line is the input, never the output. For each one:

1. Strip leading list markers (`-`, `*`, `•`, `1.`, `1)`).
2. Strip any leading stem (`Verify that`, `Verify`, `Check that`, `Ensure that`, `Confirm that`, `Validate that` — case-insensitive), then apply one canonical `Verify that`. Assert the remaining text does not itself begin with another stem: the result must never read `Verify that - Verify that …` or `Verify that Verify …`.
3. Give it steps, an Expected (rule 3) and a Type and labels (rule 4) — the same fields every other case in the plan carries.
4. Append it with the next free id, continuing the existing sequence.

**Existing cases are not touched.** No renumbering, no rewording, no re-deriving the ones that were already approved. `ui-evidence` and `qa` refer back to cases by id, and each feedback round is cumulative, so an id has to keep meaning the same case for the life of the run.

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

**5. An instruction changes a case in place — it is never appended.**
`delete TC-21`, `merge 3 and 4`, `TC-07's Expected should be X` all mutate the list rather than extend it. Where you own the list, apply the instruction directly: delete, merge or reword that case, retire its id without reusing it, and leave every other id untouched. Never satisfy a deletion by appending anything.

Where the list lives behind an append-only gate you cannot do this at all — appending is the only operation a comment has. Say so plainly, list the instructions you could not apply, and hand them to the run owner, who re-runs the phase with them. Do not pretend a deletion happened.

**6. Re-confirm with a diff, then re-gate.**
Show: count before → after; the ids added and what each one came from; the ids changed or retired under rule 5, each with the instruction that did it; every line discarded as a feedback comment and why; and confirmation that no other existing case was touched. Then run the GATE again.

> **If the plan feeds an append-only external gate** (e.g. a Oneshot "Test cases to be verified" list): every non-empty line of a comment becomes a case verbatim — instructions and verdict words included — and the Expected field cannot be set by comment at all, because the gate always overwrites it with a restatement of the line. So compose the reply as bare scenario lines only: no verdict word, no instructions, no bullets, no sign-off, with the Expected carried inside each line's own text. Deletions and corrections go to the run owner directly; a comment asking for one only creates another case.

Next in the pipeline: `erp-ticket-test-data`.
