---
name: change-scoping
description: Work out what a change actually touches before planning it — find the prior art you would otherwise duplicate, find every consumer of the values you are about to alter, and keep the change no wider than the ticket asks. Use when planning an implementation, deciding whether a helper already exists, judging blast radius, or when Oneshot's plan phase runs. Decides scope; never writes code.
---

# Change Scoping

A plan is wrong in two ways that reading it cannot reveal: the helper it never
found, and the consumer it never looked for. Both are absences, and an absence
leaves no trace in the artifact — the approver sees a plan that looks complete
because the missing thing is missing from the page too. Nothing downstream
recovers it either: `implement` builds what the plan says, and review reads a
diff, not the alternative that was never written.

So the defence is not care while writing. It is the search that came first.

## 1. Search the noun, not the name

The failure this skill exists to prevent, in full:

```
Grep   def get_thing_in_range|def get_thing_for_period     <the right directory>
→  managers.py:701:    def get_thing_in_range(self, …
→  managers.py:732:    def get_thing_for_period(self, …
```

Two guesses, two real methods, in the right app. The helper that mattered was in
a different file under a name neither pattern could match, and it was never
found — because **the search had succeeded**, and succeeding is what ended it.
Neither hit was recorded either: a plan that goes looking for prior art, finds
two candidates, and mentions none of them has not been careless twice. It stopped
thinking about the question the moment it got an answer.

This is why a name search is not a sweep. A pattern anchored on `def <name>`
answers *"does anything go by this name?"* — never *"what already does this
job?"*. A miss teaches you nothing, because you may simply have guessed wrong. A
hit teaches you less than it feels like it does, because the thing you found is
the thing you imagined, and the code you needed is the code you could not name.

Search instead for the identifiers that exist whether or not the helper does:

- the model, table, field or column the change reads or writes
- the constant, enum member or magic value
- the testid, display string, route, label or error message
- the settings key, feature flag or permission

You can read these off the research trace before you know what anything is
called. The helper's name you cannot.

**Rules**

- Finding a plausible helper does not end the search. The sweep ends when you
  have searched the identifiers, not when you have found something.
- A zero-hit search for a name you guessed is not evidence of absence either.
  Either search the noun or record an unknown; never report "nothing exists" on
  a failed guess.
- Noun first, name second. Name searches are for confirming a candidate you
  already have, not for finding one.
- Every candidate the sweep surfaced goes in `reuse` — the ones you rejected
  too, with one line on why. A candidate found and silently dropped is
  indistinguishable, to everyone downstream, from one you never found.
- Read what surrounds a hit. The function containing your identifier is the
  prior art, whatever it happens to be called.
- Directory lists rot — in this file, in a prompt, in your memory of the repo.
  Locate a file by searching for what it must contain, not by where it should
  live.

## 2. Prior art, before you write

For every helper you intend to add:

1. List the identifiers it would read or write.
2. Search those across the repo.
3. Read each definition that comes back, including the ones that look unrelated.

End at exactly one of: **reuse it**, **extend it**, or **neither, and say why**
in `reuse`. "I found nothing" is a claim like any other and has to rest on a
noun search.

Look hardest for the **mirror**. A helper that handles the opposite direction,
the adjacent state, or the same data one step earlier is prior art even when it
cannot do your job: it tells you where this kind of logic lives, what it is
allowed to assume, and what shape the team writes it in. Extracting the part you
both need is usually better than writing a second one that drifts.

## 3. Consumers, before you change

For every value your change alters, search its identifier and enumerate every
site that **renders, persists, exports, files, snapshots, emails, logs, caches
or keys off it** — whether or not you will edit that file.

Give particular weight to values a person or an outside system receives:
identifiers and reference numbers, filenames, document headers, email subjects,
exported columns, audit rows, anything filed with a third party. These share a
property that makes them dangerous: no test asserts them, nothing fails loudly,
and the first person to notice is whoever received the wrong one.

Never estimate this. "Probably only the one snapshot" is not a finding — count
them by name.

## 4. Breadth is never the default

Name the population your change alters: which records, which people, which
periods, which environments. If it is wider than the population the ticket
names, you do not have one plan, you have two.

**The steps implement the narrow one** — gated to what the ticket describes —
and the wider one becomes an `openQuestions` entry with that gating as its
stated default.

Writing the consequence into `risks` does not license the steps to take it. A
risk you authored is a choice you are making, and an approver must be able to
decline it by answering a question rather than by rejecting the whole plan.

## 5. What your approach commits you to

Two commitments that are cheap to make here and expensive to undo later:

- **A lookup inside a loop is an N+1.** If narrowing a change requires
  per-record data, name where that data is prefetched and how it reaches the
  helper. A plan that adds a query to a bulk path without answering this has
  moved a performance defect into the implementation.
- **A schema change is not a data change.** If the approach needs both, they are
  separate migrations. Say which you need, in which order, and whether each is
  reversible.

## 6. Where each finding lands

| What you found | Where it goes |
|---|---|
| Existing code you will reuse or extend | `reuse`, with `file:function` |
| A consequence you accept | `risks`, with the mitigation |
| A choice somebody else must make | `openQuestions`, with the default you assume |
| A real problem you are not fixing here | `outOfScope`, with where it belongs |
| Something you could not determine | Say so — an unknown beats a confident guess |

Nothing may be decided silently, and that includes what you discovered here
rather than being handed by research.
