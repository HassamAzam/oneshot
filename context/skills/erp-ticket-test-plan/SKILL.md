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

When the reply to the GATE is anything other than a go-ahead, read the whole reply first and work out what the reviewer is actually asking for. The reply is raw material, not a list of lines to paste in. Classify each line by intent (rule 1), then route it: a genuinely new scenario becomes a proper case and is appended (rules 2–4, intent 1); a line acting on an existing case edits/deletes/re-prioritizes/reclassifies/reorders/merges/splits that case in place (rule 5, intents 2–8); a verdict, question, ambiguous or meta note is answered, held or discarded, never made a case (rule 6, intents 9–12). Only newly appended cases get new ids — every untouched existing case keeps its id and wording.

**1. Classify every line by INTENT before acting on any of it.**
Read the whole reply, then decide what each line *intends*. The intent picks the route — and **only intent 1 ever appends a new case.** Decide intent in this order:

- A line that **names an existing TC number, or clearly restates a case already in the list, is an action on that case** — intents 2–8 (delete / edit / re-prioritize / reclassify / reorder / merge / split). It is *never* a new case, even when it is phrased like one. `TC-22: record its exact casing…` edits TC-22's Expected; `TC-22 and TC-23 should be [high]` changes their severity; `TC-21 is junk, delete it` deletes TC-21. Appending any of these leaves the named case untouched and adds a junk twin.
- A line that is a **process word or commentary about the list** — a verdict, a heading, a "suggested expectations:" lead-in, a "N things to fix by hand" note, a sign-off — is intent 9–11. Proceed or discard; never a case.
- A line that is a **genuinely new, executable scenario** is intent 1 — append it (rule 2).
- A line that reads like a new case *and* an edit is intent 12 — **ask**. Never silently guess, never silently drop.

| # | Intent | Example phrasing | Action |
|---|---|---|---|
| 1 | **Add** | "also add a case for the empty/zero state" | Append a new case — the only append route (rules 2–4) |
| 2 | **Delete** | "TC-N is junk, remove it" | Delete that case; retire its id; record in the diff (rule 5) |
| 3 | **Edit text/Expected** | "TC-N: the Expected should be…" | Replace that case's scenario/Expected — **no** new case (rule 5) |
| 4 | **Re-prioritize** | "TC-N should be [high], not [medium]" | Change that case's severity (rule 5) |
| 5 | **Reclassify type** | "TC-N is a regression case, not edge" | Change its Type (rule 5) |
| 6 | **Reorder** | "run TC-N first — it's a pre-condition for TC-M" | Change run order (rule 5) |
| 7 | **Merge / dedupe** | "TC-N and TC-M are the same, combine them" | Merge into one; delete the duplicate (rule 5) |
| 8 | **Split** | "TC-N tests two things, split it" | Turn one case into two (rule 5) |
| 9 | **Approve** | the single word "approved" | Proceed unchanged (rule 6) |
| 10 | **Question** | "does TC-N cover the short-form path?" | Answer or ask back — never a case (rule 6) |
| 11 | **Noise / meta** | "Disapproved", "Suggested expectations:", "N things to fix by hand:", "I'm happy to approve" | Discard (rule 6) |
| 12 | **Ambiguous** | reads like a new case *or* an edit | Ask before acting (rule 6) |

A line can carry two intents at once — `TC-N is junk, instead verify that the filter survives a refresh` is a delete (intent 2) *and* an add (intent 1); split it and route each half.

> Classic mis-routes, all the same failure — a non-append intent appended as a new case, leaving the list to grow append-only across rounds while the named case stays untouched: a verdict (`Disapproved`) appended as `Verify that Disapproved` / Expected `Matches the QA-reported edge case: Disapproved` (intent 11 → 1); a delete (`TC-N is junk — please delete it`) appended as a fresh case while TC-N survives (intent 2 → 1); an Expected edit (`TC-N: record its exact casing…`) appended as a standalone case instead of replacing TC-N's Expected (intent 3 → 1); a severity change (`TC-N and TC-M should be [high]`) appended rather than re-prioritizing those cases (intent 4 → 1); a sign-off (`Once TC-N is gone I'm happy to approve`) appended as a case (intent 11 → 1). In each, the correct route was to act on the named case (or discard the meta line), never to append.

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

Where the list lives behind an **append-only external gate** you cannot do any of this — appending is the only operation a comment has, and a comment asking for a deletion or an edit only creates another case. Say so plainly, list the intents 2–8 you could not apply, and hand them to the run owner, who re-runs the phase with them. Do not pretend a deletion or an edit happened.

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

WRONG — append-only:
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

**6. Intents 9–12 never touch the case list.**
The remaining intents change nothing structurally — they are answered, acted on outside the list, or held:

- **Approve (9)** — a go-ahead. Proceed to the next phase; leave every case exactly as it is.
- **Question (10)** — the reviewer is asking, not instructing. Answer it (or ask back); if the answer implies a change, that change is a *fresh* intent 1–8 line to route on its own. The question itself is never a case.
- **Noise / meta (11)** — verdict words, headings, "suggested expectations:" lead-ins, "N things to fix by hand" notes, greetings, `@mentions`, `---`, blank lines, sign-offs. Discard; record in the diff as discarded and why.
- **Ambiguous (12)** — reads like a new case *and* like an edit, or names no case yet clearly refers to one. Ask which before acting. Never silently append, never silently drop.

**7. Re-confirm with a diff, then re-gate.**
Show: count before → after; the ids added and what each one came from (intent 1); the ids changed or retired under rule 5 (intents 2–8), each with the line that did it; every line answered or discarded under rule 6 (intents 9–12) and why; and confirmation that no other existing case was touched. Then run the GATE again.

> **If the plan feeds an append-only external gate** (e.g. a Oneshot "Test cases to be verified" list): every non-empty line of a comment becomes a case verbatim — instructions and verdict words included — and the Expected field cannot be set by comment at all, because the gate always overwrites it with a restatement of the line. So compose the reply as bare scenario lines only: no verdict word, no instructions, no bullets, no sign-off, with the Expected carried inside each line's own text. Deletions and corrections go to the run owner directly; a comment asking for one only creates another case.

Next in the pipeline: `erp-ticket-test-data`.
