---
name: review-threads
description: >
  Code review as threads on the merge request, by two sessions with two jobs:
  a reviewer that raises each finding as its own thread and later rules on the
  answers, and a fixer that answers each thread with a commit or a reason. Use
  when Oneshot's `review` phase runs on a ticket that has a merge request, when
  its on-demand `review-fix` phase runs, or when asked to "review this MR and
  post the comments", "fix the review comments", "resolve the review threads".
  Covers how to write a finding a person can act on from the MR, how to grade
  it once, what a re-check may and may not raise, and when the fixer should
  decline instead of fix. Neither session posts: the conductor does.
---

# Review threads — one raises, one fixes

Two sessions. They never share a context, and neither can do the other's job:

| | Reviewer (`review`) | Fixer (`review-fix`) |
|---|---|---|
| Reads | the whole change, then only what changed since | the threads it is handed |
| Writes code | never — no write scope on the worktree | yes, and commits |
| Raises findings | yes | never — an id it was not handed is ignored |
| Returns | `findings`, and on a re-check a ruling per thread | an answer per thread |
| Posts on GitLab | no | no |

The conductor posts for both, from what each returns: one resolvable thread per
finding, pinned to its diff line when the line is in the diff; the fixer's reply
on the thread, which is resolved when the fix landed; the reviewer's ruling when
it reopens, withdraws or stands by one. Each note carries a hidden marker, so a
finding, an answer and a person's comment can be told apart although one account
posts them all.

The prompt for each phase is the contract. This file is the judgement behind it.

## If you are the reviewer

### A finding is read on the merge request, by a person

Not by you next lap, and not by a model holding this prompt. Write each one so
it stands alone there:

- `what` — the defect, in one sentence, naming the thing by its real name.
- `why` — a concrete failure: these inputs or this state give that wrong result.
  "This is bad practice" is a suggestion at most.
- `fix` — what to change. It is advice the fixer will weigh, so it must be right:
  when it depends on data (a key being unique, a field always present), cite the
  `file:line` where that data is produced and show the property holds. If you
  cannot, say so and name the real options. Never prescribe a guess — on the run
  this loop was built after, the reviewer's own prescribed assertion turned out
  to be a tautology, and the next lap raised a major against it.

No "lap 2", no "as above", no other finding by number alone.

### Grade it once

A thread's severity is fixed when it is raised.

| Severity | Means | Holds the merge |
|---|---|---|
| `blocker` | data loss, a security hole, a crash on the main path, a broken deploy, a requirement not met | yes |
| `major` | wrong behaviour a user or another module will hit | yes |
| `minor` | correct but fragile, misleading, or a standard not followed | no |
| `suggestion` | would be better; nothing breaks without it | no |

If you are torn between two, it is the lower one. You cannot raise it later: a
re-check may reopen a thread, never re-grade it.

### One finding per defect

Two symptoms of one cause are one thread. A finding the fix for another will
necessarily close is not a second finding.

### Every finding is answered

A minor or a suggestion costs what a blocker costs: a thread, a fixer's answer,
and — if the fixer commits — the whole case list verified again. Raise one only
when it should change in this merge request. What can wait goes in `summary`.

### Not a finding

- A problem on the base branch, in a line this change does not touch. Name it in
  `summary` as a follow-up.
- A disagreement with a decision the approved plan made deliberately. That is an
  open question for a person, said in `summary`.
- Anything you would have to guess at to describe.

### The re-check is not a second review

You are shown each thread with what the fixer said. Rule on it:

- `accepted` — the code now closes it. Check the fix, not only the symptom.
- `reopen` — marked fixed, and it is not, or the fix is itself wrong. Your `note`
  is what the fixer acts on next, so say exactly what is still wrong.
- `withdrawn` — the fixer declined it and is right, or you were mistaken. Saying
  so costs nothing and closes a thread a person would otherwise have to read.
- `stands` — the fixer declined it and its reason does not hold. This sends the
  thread to a person with both notes on it. Write yours for that person.

Then read only the commits since your last look. A NEW thread is allowed for a
blocker, or for a defect in a line those commits added or changed. Nothing else
is posted — the conductor drops it — because the alternative is a review that
finds something new in settled code every time it is asked, and a change that
never ships.

## If you are the fixer

### Answer every thread you were handed

An entry for each, `fixed` or `declined`. One you leave out comes straight back.

### Fix

The smallest correct change that closes the finding. The reviewer's `fix` is a
suggestion from someone who read a diff: check any claim about data where the
data is produced before you build on it. If the suggestion is wrong, close the
finding a correct way and say how.

One commit per thread where practical: `fix(review): <what changed> (F-03)`.
Run what covers the lines you touched. Touch nothing a thread does not require.

Stage by path (`git add <file>`), never `git add -A` or `git add .`: the worktree
holds scratch files that are not part of the change. Stay on the branch you are
on. Leave nothing modified and uncommitted — the conductor counts a fix by its
commit and moves anything else out of the tree.

### Decline

Declining is an answer, not a failure. Decline when:

- the finding is wrong — show why, with `file:line`;
- a correct fix lies outside this ticket's scope;
- it contradicts the approved plan or a QA-approved test case — say which, and
  that a person has to pick between them.

Never ship a workaround to make a thread go away, and never mark `fixed` without
a commit that fixes it: the conductor checks, and a "fixed" with nothing behind
it is recorded as declined anyway.

A declined blocker or major stays open: the reviewer rules on your reason, and a
person decides if the two of you still disagree. A declined minor or suggestion
is answered and closed — so its reason is the last word on it; make it one a
later reader can use.

### A person's reply outranks both sessions

When a thread shows a reply from a reviewer on the merge request, that is what a
person asked for. Do it, or say precisely why it cannot be done.

### The reply

It is posted on the thread as your answer. What changed and where (`file:line`),
or why nothing did. Plain sentences. No @mentions, no slash commands.

## Both

- Do not post, push, resolve or reopen anything. You have no tool for it, and the
  conductor does it from what you return.
- A thread still open after the last fix lap, or one you two disagree on, parks
  the run for a person with the thread listed. That is the loop working, not
  failing: say what is true and let it get there.
