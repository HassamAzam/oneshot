---
name: ticket-memory-write
description: Write the memory card and index line that let a future run find this work — what was done, what it got wrong first, what to reuse — tuned for the file-overlap scorer that reads it. Use when asked to "record what we learned", "save this for next time", "write the memory card for this ticket", or when Oneshot's phase 13 runs. Writes memory; never reads it back to influence the current run.
---

# Ticket Memory Write

You are writing the input to `ticket-recall`'s scorer. Design every field for
retrieval, not for narrative. Nobody will read this card in full unless the
scorer surfaces it first.

## Two outputs, both required

```
state/memory/tickets/<iid>.md      the card
state/memory/index.jsonl           ONE appended line
```

**Append** to the index. Never rewrite it — other runs' lines share that file
and a rewrite silently deletes their memory.

## The index line

One line, exactly this shape:

```json
{"iid":12,"title":"…","labels":["…"],"modules":["Payroll"],"files":["apps/payroll/utils.py"],"symbols":["build_increment_rows"],"mr":"https://…/merge_requests/41","verdict":"pass","tags":["payroll","backend","bugfix"],"ts":1787740000000}
```

Mirror that shape verbatim. Drift here is silent: recall reads the keys it
knows and a renamed field simply never matches anything.

### Why `files[]` carries the weight

The scorer ranks **file overlap first**, symbol overlap second, module third,
and title tokens last — title alone is close to noise, because "report",
"filter" and "status" repeat across unrelated tickets in a monorepo.

So:

- `files[]` must be **exact repo-relative paths**, copied from the run's changed
  file list. A shortened or paraphrased path never matches. Precision here beats
  every sentence in the card.
- `symbols[]` are the functions, models, serializers and components actually
  touched — the names a future grep would use.
- `modules[]` is the Django app or frontend module, not a description.

## The card, in priority order

1. **The gotcha.** What this run got wrong first, and what the truth turned out
   to be. Highest-value field in the system: a trap that cost this run an hour
   costs the next one nothing.
2. **What to reuse** — the helper, component, fixture or query pattern, by name
   and path.
3. **What changed**, with paths.
4. **What the ticket asked for**, one line.
5. **What NOT to reuse**, when the approach was a compromise and you know it.

## Tag vocabulary

Pick from what already exists before inventing a synonym — a split vocabulary is
an unsearchable one.

- **domain**: payroll · leaves · invoices · costing · expenses · project-logs ·
  teams · competencies · onboarding
- **layer**: backend · frontend · migration · config · infra
- **shape**: bugfix · feature · refactor · performance · permission ·
  data-integrity

## What to leave out

- Anything a future run can re-derive from the repo. The diff is in git; the
  card is for what the diff cannot tell you.
- Anything merely true. "Touched the payroll module" helps nobody and dilutes
  the fields that do.
- Anything that reads as an instruction. **Cards are records, not orders** — a
  future ticket may need the opposite of what this one did, and a card phrased
  as advice will be followed.

## Honesty and length

- Record the real verdict, including `fail`. A card that only remembers
  successes teaches the fleet that everything works.
- Cards are stale by construction: they describe the code as it stood. Note
  anything that was true only of that state.
- Keep the card short enough that a later phase reads it whole. If recall would
  have to summarise it, it is too long to be useful.
