---
name: mr-documentation
description: Write the durable record of a finished piece of work — one note on the MR (what changed, why, how it was verified, evidence links) and one note on the ticket (acceptance-criteria checklist with met/unmet status, QA verdict, memory-card link). Use when asked to "document this MR", "post the AC status", "write up what we did for the reviewer", or when Oneshot's phase 14 runs.
---

# MR Documentation

Two surfaces, one rule: **acceptance criteria live on the ticket, engineering
detail lives on the MR.** Never both. The second copy is the one that goes stale
the moment the ticket is amended, and nobody knows which they are reading.

One note on each. If a note for this run already exists, edit it — a thread of
five progressively-corrected summaries is not a record.

## The ticket note

The audience is whoever accepts the work.

- **Every acceptance criterion, verbatim**, each marked `MET` / `NOT MET` /
  `NOT VERIFIED`, with the case id that establishes it. A criterion with no case
  behind it is `NOT VERIFIED` and is the single most useful line in the note.
- **The QA verdict** and the SHA it was taken against — the deployed run, not
  the local one.
- Evidence links, and the MR link.
- A link to the memory card for this run.

Nothing about implementation. No file list, no findings, no lint status.

## The MR note

The audience is a reviewer with the diff already open. Extend the changelog;
do not restate it.

- **Review verdict**, and any finding deliberately left open — by id and
  severity, with why it was left.
- **The verification chain**, in one line each: lint, tests, local browser N/M
  cases, demo-server QA on `<sha>`.
- **Regressions found** and their disposition.
- **Migrations** and what they do to rows that already exist.

No acceptance criteria. No case-by-case table.

## Attaching evidence

`upload_markdown` rejects absolute paths and paths outside the project
directory. Copy each file into a directory inside the working directory, upload
by **relative** path, verify the URL came back, then remove the copy. Full rules
in `ui-evidence-pack`.

Upload before you write the note that links it.

## Honesty rules

- **Report the ids the API returned.** A null note id is a permitted outcome; a
  fabricated one is not, and it is indistinguishable from success until someone
  goes looking for the note.
- Link only artefacts that exist and uploads that returned a URL.
- Record a `fail` verdict as `fail`. This note is the thing a human reads to
  decide whether to trust the run — a rosy one costs more than a bad result.
- If a phase never ran, say it never ran. Do not infer its outcome from the
  phases around it.

## Not your job

- **Never change a label, state, assignee or milestone.** The conductor owns
  ticket state; a note that also moves the board makes the two disagree.
- Never merge, close, or re-open anything.
- Never write acceptance criteria the ticket did not state.
