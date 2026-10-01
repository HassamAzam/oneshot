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

**Derive every "Expected" for the change itself from the ticket's business logic, NOT the code's output.** If the expected value comes from the same code path you are testing, a systematic bug passes silently. This rule decides *whether the change works*. It does not cover the facts around the change — those come from the code, next section.

## Trace every fact about the product to the line that produces it

Everything else a case states about the product is a fact about code the ticket did not ask to change. The ticket cannot tell you any of it; only the code can. That covers:
- label, heading, link and button text, message wording and casing, a file's header row
- routes, selectors and `data-testid`s, and the option names a filter or dropdown offers
- what an empty, zero or missing value shows, and which records are drawn at all
- whether a field is read-only or required, and who can reach the screen
- when a request fires, and how sort and filter behave

Written from a field name, a class name, the plan's file list or a framework habit, these are wrong often enough to be the single biggest reason QA sends a list back: roughly 60% of the revision requests on erp#8745, #8768 and #8772, each costing a gate round.

For each such fact:
- **Read the line that emits it, and cite where it lives** — the file and the function, constant or template name (`views.py` `HoldPayslipView`, `displayText.js` `NO_CHANGES_IN_GIVEN_TIME_SPAN`). Add a line number only if you copied it from the file you opened: a guessed line number is a wrong fact like any other. Follow the value to where it is decided — the helper and the helpers it calls, serializer, reducer, model `verbose_name`/`Meta`/`__str__`, template or constant — not just the render line, and not just the line the plan quotes.
- **Find the condition that makes it appear at all — and what can quietly drop it.** Before a step clicks, reads or counts something, read what renders, lists or opens it — a permission, a status, a waiting period, the page size, the queryset that decides which records can be listed or opened — and make the precondition satisfy it. Before expecting a record in a list, popup or export, read the code that builds that list: a filter, a value that fails to parse, or a guard that returns nothing removes it without an error. A helper that returns `None` for a top-level team can return `0` for a sub-team; an "Evaluate" button can stay hidden until months after completion; an all-day event whose bare date fails the popup's date-time parse is never listed.
- **Same name is not the same code.** Check what is actually used: the template the admin theme resolves to (this repo runs Grappelli, not stock Django admin), the component the second screen imports (often its own copy), the admin class's real options (no `search_fields`, no search box), the element a `data-testid` sits on.
- **A harness you write runs the whole path.** When a case builds its own shell snippet, test client or mocks, trace every step between the request and the changed line — permission, validator, lookup, serializer. Anything you do not mock runs for real, and one of them can end the request (a 400, a 403, an empty list) before the change is ever reached. The same goes for the command: a test runner only runs files its discovery pattern matches.
- **Unchanged code, the framework and its libraries are in scope.** The diff and `uiPath` are where you start, not where you stop: model labels, admin templates, neighbouring components, and the installed framework's and libraries' own source and defaults (a component's default separator, a date library's strict parsing) all decide what the screen shows.
- **Trace copied claims too.** A fact taken from the plan, the research block, the design note or a reviewer's comment is a claim about the code. Check it before it becomes a case.
- **Cannot trace it? Do not guess an exact literal.** Assert it by structure or `data-testid`, or compare ignoring case, and say in the case that the literal is unverified.

**The diff's own lines are never a source for an Expected.** Tracing sends you into code, and the changed code is right there — so check every citation behind an expected value against the diff. If the line is one the diff adds or changes (a new label or message, a new log line, a new condition, the argument form of a new call, a threshold in the branch's own test), that value is the change's result, not a fact about the product. Take it from the ticket, plan or approved design instead; where they do not fix the exact wording, assert loosely (the date is shown, the row is hidden) rather than copying the new string. Something the ticket never asks for — a log line, a keyword-argument form — is not a pass condition at all.

**The branch's own new test is never the pass condition either.** Running it can be a step, but "the new test passes" proves only that the code agrees with a test its own author wrote — both can miss the ticket in the same way. Measure what the ticket or plan asks for yourself: ❌ `pass if test_pod_membership_data_query_count passes` → ✅ `count the queries for a POD and a non-POD request on the same team; the POD one issues exactly one more (plan step 12)`.

❌ `Click 'Add another Subteam approver'` — built from the class name.
✅ `Click 'Add another Custom Subteam Approver'` — the model's `Meta.verbose_name` (apps/teams/models.py).
❌ `A missing team id returns HTTP 404` — framework habit.
✅ `Redirects to the admin index with the warning 'Team with ID “…” doesn’t exist. Perhaps it was deleted?'` — what the installed Django version's `ModelAdmin` does, curly quotes included.
❌ `Select 'PF Staff' in the Pay Structure filter` — the column's text reused as the option name.
✅ `Select 'PF'` — the filter's options are the keys of `PAY_STRUCTURE`; only the column shows 'PF Staff'.

## Walk the traps list before you present

**Read `refs/traps.md` and walk it against your draft before the GATE.** It holds numbered **principles**, each generalising revision requests QA has already had to make on real tickets — cases that failed on a correct build, passed on an unchanged one, or were never written at all. Walk the principles, not the examples: the bullets under each one are illustrations of it, and the principle is what has to fire on a screen they never mention. It is the difference between a list that is approved in one round and one that costs three.

Three checks to run over the finished draft:

- **Can you point at the line behind every literal the case quotes — and is that line outside the diff?** If you cannot, trace it or loosen it; if the diff wrote it, take it from the ticket or plan instead (see "Trace every fact about the product").
- **Would this case still pass if the diff were reverted?** If yes it proves nothing about the change. Keep it if it guards a regression, but label it a smoke check and give it a positive control (principle 5).
- **Does this change REMOVE something that was hiding a state** — a blur, a disabled look, a muted colour, a collapsed row? Then write the cases for what it was hiding, not just for its absence (principle 6). This class is the most-missed one on record.

Note in your output which traps you applied and which you considered and ruled out, so the reviewer can see the list was walked rather than skimmed.

## Present + GATE

Show the full plan as a numbered list (Type · Scenario · Expected). Then:

> **GATE — WAIT for explicit go-ahead.** Do not create data or execute until the user confirms. If the reply is anything other than a go-ahead, route each line by intent (see "Revising the plan after feedback"): **add** appends a new case, **drop/modify** act on the case named — delete, edit, re-prioritize, reclassify, reorder, merge or split it in place — then re-confirm. Only "add" ever creates a case.

Also surface here: which scenarios are UI-driven vs API/webshell, and which **persist data / send real emails** (destructive) vs which roll back (safe).

## Revising the plan after feedback

When the reply to the GATE is anything other than a go-ahead, read the whole reply first and work out what the reviewer is actually asking for. The reply is raw material, not a list of lines to paste in. Classify each line by intent (rule 1), then route it: a genuinely new scenario becomes a proper case and is appended (rules 2–4, intent 1); a line acting on an existing case edits/deletes/re-prioritizes/reclassifies/reorders/merges/splits that case in place (rule 5, intents 2–8); a verdict, question, ambiguous or meta note is answered, held or discarded, never made a case (rule 6, intents 9–12). Only newly appended cases get new ids — every untouched existing case keeps its id and wording.

**1. Classify every line by INTENT before acting on any of it.**
Read the whole reply, then decide what each line *intends*. The intent picks the route — and **only intent 1 ever appends a new case.**

> **More than one round in front of you? Only the LAST one is live.** Feedback accumulates: a re-run of this phase is shown every round so far, oldest first. The earlier rounds acted on a list that has since changed, so their TC numbers may now name a different case or none at all — replaying them re-applies work already done and re-adds cases already dropped. Route the LAST round against the list you actually hold; read the earlier ones for context only.

Decide intent in this order:

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

The phase's core rule applies unchanged: derive the Expected for the change from the ticket's business logic — not from the scenario's own wording, and not from the changed code's output. Every other fact the case states — including one the reviewer's line states — is traced to its line first, as in "Trace every fact about the product". State both:
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

This labelling holds for every case you author, including the ones you rewrite after feedback. The single exception is the gate's approve-and-add round (rule 7): cases appended there are tagged `boundary` / `medium` uniformly, on the reasoning that free text cannot safely imply either. So for a case added that way, if a Type matters downstream, say it inside the scenario line's own words — the structured field will read `boundary` no matter what you intended.

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

**Check the reason behind a delete.** "Drop it, the unit tests already check this" or "another case covers it" is a claim like any other. Before deleting on that ground, confirm the covering test exists *and runs* — `testsRun` in implement's artifact, the CI config, the runner's discovery pattern. If it does not run (this repo's frontend Jest does not), keep the check, move it to a runner that works (Playwright, pytest), and say why in the re-confirm diff.

**Where you own the list you must apply them — and in the Oneshot `testcases` phase you do.** A reply that is not a sign-off cycles this phase: the reviewer's words arrive in your prompt, `testcases.json` is in your worktree, and you output the whole revised list. A delete is a case you do not write out; an edit is a case you write out changed. Nothing is handed back to anybody, and a request to delete must never return as a case reading `Verify that TC-N is deleted` — that leaves the named case alive and adds a junk twin beside it.

The one exception is a round where the reviewer wrote `approved` AND named a case in the same comment. That round takes the gate's append path (rule 7), which has no delete or edit verb. Only there: say so plainly, list the intents 2–8 you could not apply, and hand them to the run owner. Do not pretend a deletion or an edit happened.

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

Walk `refs/traps.md` over the revised list too — a revision round is exactly where a trap resurfaces, because the cases you just rewrote are the ones nobody has checked yet. And trace every literal you added or changed this round to its line: the fix for one wrong label is where the next wrong label usually comes from.

**8. Name the trap this round taught you.**
If the feedback names something `refs/traps.md` does not already cover, end your output with a `candidateTraps` block. **Say which of the two it is, because they are curated differently:**

- **A new instance under principle N** — the principle already covers it and this is a shape of it nobody had written down. Name the principle, give the bullet, and say what in this ticket the existing bullets did not reach. This is the common case.
- **A new principle** — no existing principle covers it. Say which ones you checked and why each missed, then state the principle as a rule about authoring a case. If stating it needs a sentence about how the code should be built or how the repo should be configured, it belongs to another phase and is not a candidate here.

Either way: stated generally enough to fire on a different ticket, how it bites a case, what to assert instead, and the source as a full URL — ticket numbers are not unique across projects. Do not edit `refs/traps.md` yourself; it is shared by every run and a human curates it. Proposing the candidate is the whole job.

> **The approve-and-add round is the only append-only path left.** When a reviewer signs off AND names a case in the same comment, the gate appends that case mechanically rather than cycling this phase: only bullet lines (`- Verify that …`) and lines opening with a test verb are read, every other line is dropped, and each appended case is tagged `boundary` / `medium` with `Matches the QA-reported edge case: …` as its Expected unless the line carries its own `expects:` clause. Every other reply cycles this phase, where you rewrite the list yourself under rules 1–6.

Next in the pipeline: `erp-ticket-test-data`.
