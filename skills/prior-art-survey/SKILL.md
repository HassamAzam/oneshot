---
name: prior-art-survey
description: While tracing a ticket's code, record what the repo already has that the change could call, extend, mirror or is better off leaving alone — the callable, the opposite-direction sibling, the second copy, and the unnamed fragment. Use when researching a ticket, tracing an unfamiliar codebase, asking "does something like this already exist", or when Oneshot's research phase (1) runs. Surveys and cites only; never writes the helper, never edits code, never chooses the approach.
---

# Prior-Art Survey

You are already reading the files this ticket touches. Naming what is in them
costs a fraction of a turn budget you are spending anyway; the phase that plans
the fix has neither your budget nor your open files.

Measured across seven runs of one ticket: a later phase sent to *discover* the
helper found it once in two attempts, at 39 turns. The same helper *handed over*
in the trace was used twice out of two, at 17 turns and for less money. A helper
you find here and do not write down is one the next phase writes from scratch.

## 1. Survey the trace, not the ticket's wording

The trace you are already building is the search surface. Every file you open to
follow execution is a file you can survey for free, and prior art clusters where
the change lands — that is what makes it prior art rather than a coincidence.

Do not run a separate hunt off the ticket's prose. The ticket names the outcome
somebody wants; the repo names the thing that already exists, and those two
vocabularies rarely agree. Work from the identifiers in the code you traced.

**Survey the file, not just the line you came for.** You paid to open it, and
the function above the one you were tracing is the cheapest finding available.

## 2. Spell every noun twice before you search it

**A stored thing is reached by its TYPE and by the FIELD or RELATION pointing at
it, and working code usually mentions only one of them.** Searching one spelling
and reporting nothing is the single most common way this survey misses the file
that mattered.

Derive the second spelling mechanically, without knowing the domain:

- **Backend** — CamelCase class → snake_case field or relation → the reverse
  accessor → the manager or queryset that wraps the lookup → the table or column
  name. A model is talked about differently in a view, in a query and in SQL.
- **Frontend** — the component name → the route constant → the testid constant →
  the `DISPLAY_STRINGS` key → the theme token, each in the constants file that
  owns it rather than at the point of use.

Search both spellings before you conclude anything about a noun. One spelling
that returns nothing is not evidence of absence; it is half a search.

## 3. Ask for four kinds of prior art, not one

"Is there a function that does this?" finds one of four things, and an
identifier search reaches only the first. Ask for each kind by name:

1. **The callable** — a helper this change can import and call. The only kind a
   search for a plausible name will ever return, which is why a survey that asks
   only this question reports "nothing exists" so confidently and so often.
2. **The mirror** — the opposite-direction sibling: start/end, open/close,
   grant/revoke, the read of the thing you are about to write. Found by
   searching the *antonym* of the ticket's verb, and by reading the whole file
   the callable lives in. A mirror is rarely callable — you copy its shape, its
   assumptions and its tests, which is worth more than the call would have been.
3. **The duplicate** — the same logic already written twice. Found by searching
   a distinctive *line* of the original rather than its name, and by one
   `TODO`/`FIXME` grep scoped to the files the trace already crosses. A
   duplicate often arrives with its intended fix attached to it.
4. **The fragment** — arithmetic or a predicate living inside a larger function,
   **with no identifier of its own**, so no identifier search can reach it. The
   route in is the *constants* it must use: grep those and read what surrounds
   each hit.

**Two findings you get for free while already in those files.** An existing
*import* is a finding — the connection between these two modules is already
sanctioned, and the next phase does not have to argue for it. A `TODO` or
`FIXME` in code you traced is a finding that names its own fix.

## 4. Resolve every hit to its enclosing definition before you judge it

This is the step that lapses, because it feels like bookkeeping while you are
mid-trace. Make it a command rather than a memory:

```
grep -nE '^[[:space:]]*(async )?(def|class) ' <file>                          # python
grep -nE '^(export (default )?)?(async )?(function|const|let|class) ' <file>  # js/ts, top level only
```

These are Bash commands; the same patterns work unchanged as a Grep-tool
pattern. Read the listing against the hit:

- **A hit that is itself a listed entry is its own definition.**
- **Python** — the enclosing definition of a hit at line N is the last listed
  entry before N that is indented LESS than line N. That skips a nested `def`
  the hit sits after rather than inside. A hit at column 0 that is not a `def`
  or `class` is a module-level statement: for a constant, that assignment line
  IS its definition.
- **JS/TS** — the list is top-level only, because a component body is full of
  local `const`s that are not definitions, so the enclosing definition is
  simply the last entry before N. The trade-off: a hit inside an inner handler
  or a class-component method resolves to the component or class line. Read
  down from there to the inner `const handleX =` or method the hit sits in, and
  cite that rather than the component line.

One command per **file**, not per hit — the cost is one call however many hits
that file returned.

**Stop a noun after two definitions you have actually READ come back.** A third
rarely changes the answer, and the budget belongs to the trace.

**A pattern returning more than about thirty hits is too loose to resolve.**
Tighten it rather than skimming it. Skimming thirty hits produces a list of
locations, which is the one output this survey must not emit.

## A hit is a location; only the definition is evidence

Rank what you found, and never promote a rung:

- **A definition you opened and read** — evidence. Report it plainly.
- **A definition you located but only read the signature of** — a *lead*. Report
  it as one, and say what you did not check.
- **A grep hit you did not resolve** — a location. Never report it alone; it
  tells the next phase a string occurs somewhere, which it could have found out
  itself for one call.
- **A name you expected from convention and never matched** — belongs in
  `unknowns`, or nowhere. It is not a finding.

**A fabricated near-match is worse than an empty survey.** An empty survey costs
the next phase one search. A confident citation of a helper that does not do
what you said costs it the search *and* the detour, and it has no way to tell
the two apart from the artifact.

## Where a thing already lives is evidence — record the file, not a verdict

**You do not decide placement, and you have no field to decide it in.** The
planning phase places the new unit, and it places it by looking at where its
mirror already sits. Your job is to make sure that file is on the record.

So when you find a mirror, the entry you write is the placement evidence: the
`mirror:` role carries the file, and that is what the next phase reads the
location off. Same for the test — **the test already covering this surface is
what tells the next phase where the new test goes**, so record it as
`test-sibling:` while you are in the file rather than leaving it to taste.

Do not name a directory you did not open, and do not recommend one. A directory
named from convention rather than from a search is exactly what lets a placement
feel decided when nothing was checked — and the next phase is explicitly
instructed to distrust it.

## Judge overlap by bars cleared, not by a percentage

A percentage of overlap is a number nobody computed and nobody can check. State
which bar a candidate clears:

- **Call it** — it does the job as it stands.
- **Extend it** — it does the job for one more case, and the existing callers
  keep working. Name the callers you **actually counted**, not an estimate.
- **Mirror it** — it cannot be called, but its shape, assumptions and tests are
  the pattern the new unit should follow.
- **Leave it** — close but not close enough. Two honest functions beat one
  function with a boolean parameter, and saying so here prevents the merge.

**"Nothing clears a bar" is a real answer and a cheap one.** Report it. It is
worth strictly more than a candidate promoted to fill the field.

## What is not prior art

An identifier sweep is densest exactly where it is worth least. Do not read, and
do not record: migration history, vendored dependencies and lockfiles, build
output and bundles, fixtures and factories. Test helpers are not prior art for
production code, nor the reverse. A framework or standard-library function is
not a duplicate of the helper that wraps it. A field name appears in every
historical migration that ever touched it, and not one of them tells you what
the code does today.

**One carve-out, and it is the useful one.** A vendored file your own code
EXTENDS, OVERRIDES or SUBCLASSES is a mirror, and citing it is correct: it is
where the behaviour you are about to add already exists, and reading it is how
you learn what your override has to fill in. Tag it `mirror:` like any other,
and say in the role that it is vendored so nobody plans an edit to it. What the
exclusion above is really refusing is the sweep that trawls dependencies you
never touch — not the base class you inherit from.

## Turn economy — the survey is a slice of the phase, not its subject

This runs inside the trace and shares its budget. The trace is the deliverable;
the survey is what you pick up while producing it.

- **Batch the sweep.** One pattern covering several identifiers beats one search
  each. You are finding where a kind of logic lives, not building an index.
- **Resolve per file, not per hit.** One definition-listing call answers every
  hit that file returned; only a js/ts hit inside an inner handler or method
  costs the short read down from its component.
- **Spend where being wrong is expensive.** A helper the next phase would
  otherwise rewrite is worth turns; confirming what you already believe is not.
- **Stop when a line of search stops changing the answer.** Three files that
  agree about a value have told you what the fourth says.

## Output

Everything lands in `codePath`, alongside the trace. That field's schema carries
the `file` / `line` / `role` contract — including why `line` wants the
definition and never a line inside a body that a search matched — so fill them
from there rather than from here.

The six `role` prefixes are the four kinds you hunt — `callable:` / `mirror:` /
`duplicate:` / `fragment:` — plus the two you pick up on the way: `constant:`
for a value the change must use, and `test-sibling:` for the test already
covering the surface. An existing import and a `TODO` in traced code are
findings too; file them under the kind they point at.

Two calls no schema can make for you, because each is about which field to
choose rather than how to fill one:

- **Frontend strings go to `uiPath.vocabulary`, not to `codePath`** — testids,
  display-string keys, labels. Every later phase looks for them there.
- **A noun reaches `unknowns` only once you have searched it BOTH ways.** One
  spelling is half a search, and half a search has not earned the entry.

## Do not

- Do not report a grep hit you never resolved to a definition.
- Do not cite a helper you did not open. A signature you read is a lead, and
  says so.
- Do not run a prior-art hunt off the ticket's wording instead of the trace.
- Do not conclude "nothing exists" from one spelling of a noun.
- Do not put a percentage on an overlap, or a candidate in a field to fill it.
- Do not choose the approach or say what the fix should be. A bar is a statement
  about what the code can support; ranking the candidates by preference, or
  naming the one to use, is the planning phase's call.
- Do not recommend a directory for the new unit — record where its mirror lives
  and let the next phase place it.
- Do not write, edit or refactor any code.
