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

> **GATE — WAIT for explicit go-ahead.** Do not create data or execute until the user confirms. If the reply is anything other than a go-ahead, route each line by intent (see "Revising the plan after feedback"): **add** appends a new case, **drop/modify** act on the case named — delete, edit, re-prioritize, reclassify, reorder, merge or split it in place — then re-confirm. Only "add" ever creates a case.

Also surface here: which scenarios are UI-driven vs API/webshell, and which **persist data / send real emails** (destructive) vs which roll back (safe).

## Revising the plan after feedback

When the reply to the GATE is anything other than a go-ahead, read the whole reply first and work out what the reviewer is actually asking for. The reply is raw material, not a list of lines to paste in. Classify each line by intent (rule 1), then route it: a genuinely new scenario becomes a proper case and is appended (rules 2–4); a line acting on an existing case edits/deletes/re-prioritizes/reclassifies/reorders/merges/splits that case in place (rule 5); a verdict, question or meta note is answered or discarded, never made a case. Only newly appended cases get new ids — every untouched existing case keeps its id and wording.

**1. Classify every line by INTENT before acting on any of it.**
Read the whole reply, then decide what each line *intends*. The intent picks the route — and **only intent 1 ever appends a new case.** Decide intent in this order:

- A line that **names an existing TC number, or clearly restates a case already in the list, is an action on that case** — intents 2–8 (delete / edit / re-prioritize / reclassify / reorder / merge / split). It is *never* a new case, even when it is phrased like one. `TC-22: record its exact casing…` edits TC-22's Expected; `TC-22 and TC-23 should be [high]` changes their severity; `TC-21 is junk, delete it` deletes TC-21. Appending any of these leaves the named case untouched and adds a junk twin.
- A line that is a **process word or commentary about the list** — a verdict, a heading, a "suggested expectations:" lead-in, a "N things to fix by hand" note, a sign-off — is intent 9–11. Proceed or discard; never a case.
- A line that is a **genuinely new, executable scenario** is intent 1 — append it (rule 2).
- A line that reads like a new case *and* an edit is intent 12 — **ask**. Never silently guess, never silently drop.

| # | Intent | Example phrasing | Action |
|---|---|---|---|
| 1 | **Add** | "also add a case for an empty export" | Append a new case — the only append route (rules 2–4) |
| 2 | **Delete** | "TC-21 is junk, remove it" | Delete that case; retire its id; record in the diff (rule 5) |
| 3 | **Edit text/Expected** | "TC-22: the Expected should be…" | Replace that case's scenario/Expected — **no** new case (rule 5) |
| 4 | **Re-prioritize** | "TC-22 should be [high], not [medium]" | Change that case's severity (rule 5) |
| 5 | **Reclassify type** | "TC-17 is a regression case, not edge" | Change its Type (rule 5) |
| 6 | **Reorder** | "run TC-23 first — it's a pre-condition for TC-06" | Change run order (rule 5) |
| 7 | **Merge / dedupe** | "TC-22 and TC-05 are the same, combine them" | Merge into one; delete the duplicate (rule 5) |
| 8 | **Split** | "TC-04 tests two things, split it" | Turn one case into two (rule 5) |
| 9 | **Approve** | the single word "approved" | Proceed; leave the list unchanged |
| 10 | **Question** | "does TC-06 cover the short-form export?" | Answer or ask back — never make it a case |
| 11 | **Noise / meta** | "Disapproved", "Suggested expectations:", "Four things to fix by hand:", "I'm happy to approve" | Discard |
| 12 | **Ambiguous** | reads like a new case *or* an edit | Ask — never silently guess |

A line can carry two intents at once — `TC-21 is junk, instead verify that the filter survives a refresh` is a delete (intent 2) *and* an add (intent 1); split it and route each half.

> Real failures (ticket #244, one review round grew the list 20 → 39, all append-only): the verdict `Disapproved` became `TC-21 · Verify that Disapproved` / Expected `Matches the QA-reported edge case: Disapproved` (intent 11 mis-routed to 1). The delete `1. TC-21 is junk — please delete it` became `TC-29` while TC-21 survived (intent 2 → 1). The Expected edit `TC-22: …record its exact casing…` became a standalone `TC-32` (intent 3 → 1). The severity change `TC-22 and TC-23 should be [high]` became `TC-38` (intent 4 → 1). The sign-off `Once TC-21 is gone… I'm happy to approve` became `TC-39` (intent 11 → 1). Not one named case was actually changed.

**2. Author each feedback scenario into a real case, then append it (intent 1 only).**
This is the *only* route that creates a case. The reviewer's line is the input, never the output. For each intent-1 line:

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

**5. Intents 2–8 change a case in place — never appended.**
Delete (2), edit text/Expected (3), re-prioritize (4), reclassify Type (5), reorder (6), merge/dedupe (7), split (8) all *mutate* the list rather than extend it — this is the "drop/modify" the GATE promises. **Where the plan is under your own control, you must apply them, not append them:**

- **Delete** — remove the case; retire its id without reusing it.
- **Edit text/Expected** — replace that case's scenario or Expected in place; keep its id.
- **Re-prioritize** — change that case's severity.
- **Reclassify Type** — change its Type (see rule 4's five types).
- **Reorder** — change run order; a pre-condition case moves ahead of the case it gates.
- **Merge / dedupe** — fold the duplicates into one case; delete the surplus id.
- **Split** — turn one case into two, each with its own Expected.

Leave every other id untouched. **Never satisfy a delete, edit, or re-prioritize by appending anything** — the named case must actually change.

Where the list lives behind an **append-only external gate** you cannot do any of this — appending is the only operation a comment has, and a comment asking for a deletion or an edit only creates another case (this is exactly how #244 grew to 39). Say so plainly, list the intents 2–8 you could not apply, and hand them to the run owner, who re-runs the phase with them. Do not pretend a deletion or an edit happened.

**Worked example — the same reviewer comment, mis-routed vs routed:**

```
Reviewer comment:
  1. TC-21 is junk — please delete it.
  3. Suggested expectations:
     TC-22: Inspect the export cell for a flagged person and record its exact
            casing; yesno() with no second arg returns lowercase "yes"/"no",
            but TC-05/06 require "Yes"/"No" — FAIL on any other casing.
  4. TC-22 and TC-23 should be [high], not [medium].
  Once TC-21 is gone I'm happy to approve.

WRONG — append-only (what #244 did):
  New case: Verify that 1. TC-21 is junk — please delete it...
  New case: Verify that TC-22: Inspect the export cell...
  New case: Verify that 4. TC-22 and TC-23 should be [high]...
  New case: Verify that Once TC-21 is gone I'm happy to approve.

RIGHT — routed by intent:
  - TC-21              → deleted            (intent 2)
  - TC-22 Expected     → replaced with the casing text; severity → [high]  (3 + 4)
  - TC-23 severity     → [high]             (intent 4)
  - "1.", "3. Suggested expectations:", "4.", "Once TC-21 is gone…" → discarded (intent 11)
  - No new cases created.
```

**6. Re-confirm with a diff, then re-gate.**
Show: count before → after; the ids added and what each one came from; the ids changed or retired under rule 5, each with the instruction that did it; every line discarded as a feedback comment and why; and confirmation that no other existing case was touched. Then run the GATE again.

> **If the plan feeds an append-only external gate** (e.g. a Oneshot "Test cases to be verified" list): every non-empty line of a comment becomes a case verbatim — instructions and verdict words included — and the Expected field cannot be set by comment at all, because the gate always overwrites it with a restatement of the line. So compose the reply as bare scenario lines only: no verdict word, no instructions, no bullets, no sign-off, with the Expected carried inside each line's own text. Deletions and corrections go to the run owner directly; a comment asking for one only creates another case.

Next in the pipeline: `erp-ticket-test-data`.
