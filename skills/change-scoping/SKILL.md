---
name: change-scoping
description: Turn a traced ticket into a scoped change — confirm the prior art you were handed, search only what your own approach introduces, place each new unit where its mirror already lives, and count every consumer of the values you alter. Use when planning an implementation, deciding whether a helper already exists, judging blast radius, or when Oneshot's plan phase (2) runs. Decides scope and routes findings; never writes code.
---

# Change Scoping

A plan is wrong in two ways that reading it cannot reveal: the prior art it
accepted without opening, and the consumer it never looked for. Both are
absences, so the plan reads as complete — and nothing downstream recovers them.
`implement` builds what the plan says; review reads a diff, not the alternative
nobody wrote.

## The prior art arrives; confirming it is your job

Research traced this ticket and recorded what it found in `codePath`, each entry
prefixed with its kind — `reuse:`, `mirror:`, `duplicate:`, `fragment:`,
`constant:`, `test-sibling:`. That is the expensive half of the search, already
paid for. Do not run it again.

**A handed `file:line` is a claim, not a fact.** Its `role` was written before
any approach existed, by a phase judging what the code *is* rather than what
your change needs. Open every location you intend to lean on and read the
function around it. Confirming a candidate costs one call; inheriting a wrong
one costs `implement` the detour and the rewrite.

**Each entry already carries a bar research judged it against; translate it, do
not inherit it.** Research says what the code *can* support, you decide what
this change *does*:

| inbound bar | your verdict |
|---|---|
| call it | **reuse it** — after you have opened it |
| extend it | **extend it** — and recount the callers yourself |
| leave it | **reject it**, with the reason on the line |
| mirror it | **not a reuse verdict at all** — it is the placement input for the section below |

End each candidate you are actually leaning on with exactly one of four
verdicts:

- **Reuse it** — call it as it stands.
- **Extend it** — one more case, existing callers unaffected. Name the callers
  you counted.
- **Collapse a duplicate onto it** — two sites carry this logic and your change
  touches one of them.
- **Reject it** — and **the rejection stays in `reuse`, with its reason on the
  same line.** A candidate found and silently dropped is indistinguishable,
  downstream, from one nobody ever found.

**Never write "no prior art" against a trace you did not open.** `implement`
reads that as permission to write a new one, and it will.

## What your approach introduces is still yours to search

Research could not trace what your approach touches, because your approach did
not exist while it ran. That gap is the honest residual, and it is exactly four
things:

- **The unit you are about to add.** Search the identifiers it would read or
  write — the model, field, constant, testid, settings key. **Never search the
  name you would have chosen**; that pattern answers "does anything go by this
  name?", and the code you need is the code you could not name.
- **Its mirror** — the opposite-direction sibling. Search the antonym of your
  verb.
- **The second site already carrying this logic**, often with a `todo` attached
  naming its own fix. Search a distinctive *line* of the first site, not its
  name.
- **The tests already covering this surface.** Find them by identifier, not by
  directory. If the surface has no test today, that is a finding worth a line,
  not a silence.

**Prior art is not always an exported symbol.** A fragment — arithmetic or a
predicate inside a larger function — has no name to search and is cited as
`file:line-line`.

**What is not prior art.** Do not read, and do not record: migration history,
vendored dependencies and lockfiles, build output and bundles, fixtures and
factories. Test helpers are not prior art for production code, nor the reverse.
A framework function is not a duplicate of the helper that wraps it. The one
carve-out: a vendored file your own code extends, overrides or subclasses IS a
mirror — confirm it and copy its shape, but no step ever edits it, so say so on
the line.

## Place a new unit where its mirror lives

**A location is a search key, not a filing decision.** Where a thing goes is
answered by what is already next to it.

**Mirror first.** The new unit goes in the file its mirror occupies, and the
step says so by name — that settles most placements, with evidence rather than
taste. No mirror, then the ladder:

Count the CALLERS the new unit will have, and read the rung off that count:

- **Exactly one, and clearly never a second** → inline, at its one call site.
  Say so explicitly, or the next phase invents a utility file for it.
- **Several, all inside one module** → that module's `utils/` (or `utils.py` —
  check which shape this app chose), or `managers.py` / `querysets.py` when the
  logic is a lookup.
- **Callers in more than one module** → `common/` on the backend,
  `frontend/src/common/**` on the frontend.

Components follow the same rule through the container/component split: the new
one sits on the side its mirror sits on.

**A test file's location is derived from the sibling that already tests this
surface**, and the step names that sibling. A parallel test set beside an
existing one is a fork nobody maintains.

**Directory lists rot** — in this file, in a prompt, in your memory of the repo.
Naming a directory is exactly what lets a placement feel decided when nothing
was searched.

## Consumers, before you change

For every value your change alters, search its identifier and enumerate every
site that **renders, persists, exports, files, snapshots, emails, logs, caches
or keys off it** — whether or not you will edit that file.

Give particular weight to values a person or an outside system receives:
identifiers and reference numbers, filenames, document headers, email subjects,
exported columns, audit rows, anything filed with a third party. No test asserts
them, nothing fails loudly, and the first person to notice is whoever received
the wrong one. Never estimate this; count them by name.

## Breadth is never the default

Name the population your change alters: which records, which people, which
periods, which environments. If it is wider than the population the ticket
names, you do not have one plan, you have two.

**The steps implement the narrow one** — gated to what the ticket describes —
and the wider one becomes an `openQuestions` entry with that gating as its
stated default. Filing the consequence under `risks` instead does not license
the steps to take it: a risk you authored is a choice you are making, and an
approver must be able to decline it by answering a question rather than by
rejecting the whole plan.

## What your approach commits you to

Two commitments that are cheap here and expensive to undo later. **State only
the ones the approach actually raises** — a change with no bulk path owes
nothing on N+1, one touching no model owes nothing on migrations.

- **A lookup inside a loop is an N+1.** If the change needs per-record data,
  name where that data is prefetched and how it reaches the helper. A plan that
  adds a query to a bulk path without answering this has moved a performance
  defect into the implementation.
- **A schema change is not a data change.** If the approach needs both, they are
  separate migrations. Say which, in which order, and whether each is
  reversible.

## Where each finding lands

| What you found | Where it goes |
|---|---|
| Code you will reuse, extend or collapse onto | `reuse`, with `file:function` or `file:line-line` |
| A candidate you rejected | `reuse`, with the reason on the same line |
| A consequence you accept | `risks`, with the mitigation **and the check** |
| A choice somebody else must make | `openQuestions`, with the default you assume |
| A real problem you are not fixing here | `outOfScope`, with **how you ruled it out** |
| An item from research's `unknowns` | Resolved with `file:line`, or `openQuestions`, or `outOfScope` — never silently |
| Something you could not determine | Say so — an unknown beats a confident guess |

Four rules about that table decide whether the approver can act on this plan:

- **`reuse` is addressed to `implement`, not to the approver.** The approver's
  view of a plan renders the approach, open questions, steps, acceptance
  coverage, risks and out-of-scope — and **not `reuse`**. Anything a person must
  be able to *decline* therefore cannot live there: route it to `approach`,
  `openQuestions`, `outOfScope`, or a step's `what`. Not `risks` — a scope
  choice filed as a risk is one they can only accept or reject whole.
- **An `outOfScope` entry carries how you ruled it out**, with `file:line`. An
  entry with no evidence behind it is one the approver can only accept or reject
  whole, which is not a decision anybody can make well.
- **Say which step can be dropped**, as an `openQuestions` entry. Open questions
  render *above* the steps, under "answer these in a comment, or the stated
  default is used" — so state the default plainly, and **the default is that all
  steps ship**. `implement` reads `openQuestions` too, and without that line it
  may drop a step on its own authority.
- **`steps[].files` and `steps[].layer` are machinery, not prose.**
  `planForecast` in `src/phases/prompts.ts` reads them to decide which coding
  standards `implement` loads, and `declaredFiles` in
  `src/conductor/reviewgate.ts` uses them to scope the review gate. **A file
  left off a step is a file nobody is scoped to.**

**A risk names the check that would catch it.** Not "what breaks and the
mitigation" — what breaks, the mitigation, *and the check that would catch it
before this lands*: an assertion against a known-good value, a query count, a
named test. **A risk that names no check is unease, not a finding**, and unease
gives the approver nothing to weigh.

## Turn economy

This phase has a turn budget and it ends the run when it is spent — there is no
partial plan. The sections above ask for confirmation and a narrow search, not
for exhaustion.

- **Confirming a handed candidate is one call.** Budget one per candidate you
  lean on, and do not re-derive the survey around it.
- **Batch what is left**, and read a definition rather than a file. The function
  containing the hit is the prior art; the other four hundred lines are not.
- **An unknown recorded early is cheaper than a certainty bought late.** If a
  question costs more turns than it saves the approver, it is an `openQuestions`
  entry with your assumed default, and you move on.

Finishing well under the budget with the candidates confirmed is the phase
working, not the phase cutting corners.

## Do not

- Do not re-run research's survey. Confirm what arrived; search only what your
  approach adds.
- Do not accept a handed `file:line` you never opened, and do not report "no
  prior art" against one.
- Do not drop a rejected candidate silently — it stays in `reuse` with a reason.
- Do not put an approver-facing choice in `reuse`; they never see it.
- Do not name a directory for a placement you did not search.
- Do not estimate a consumer count, or file a risk with no check.
- Do not leave a file off the step that touches it.
- Do not write or modify any code.
