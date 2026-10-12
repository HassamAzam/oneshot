---
name: superpowers-planning
description: Write the plan so the executor never has to re-derive it — each step right-sized to one verifiable deliverable, naming the exact symbols, signatures and values it adds and every file it touches, with no "add validation" placeholders, then self-reviewed for acceptance coverage and cross-step name consistency. Use when shaping a plan's steps, deciding how small a step should be, or when Oneshot's plan phase (2) runs. Shapes how steps are WRITTEN; it does not decide scope. Never writes code.
---

# Superpowers Planning

This is the superpowers `writing-plans` discipline, adapted for an autonomous
plan phase. `change-scoping` has already decided WHAT this change touches and
WHERE each new unit goes, and routed its findings into `reuse`, `risks`,
`openQuestions` and `outOfScope`. This skill owns the one thing that leaves:
HOW each step is written, so the phase that builds it does not have to work the
plan out again.

The reader you are writing for is an executor with zero context for this
codebase and a fresh sub-agent dispatched per layer — it sees your step, not
your reasoning, and not the files you opened to write it. The cost of a step it
cannot execute verbatim is measured: implement spends most of its budget
re-reading code the plan named only in prose. A step that carries the symbols,
the signatures and the files is exactly what lets implement open a file to EDIT
it rather than re-trace it.

## Right-size every step

A step is the smallest unit that carries its own verification and is worth a
fresh reviewer's gate.

- **Fold in** the setup, config, scaffolding and wiring the step's deliverable
  needs — they are not their own steps.
- **Split** only where a reviewer could meaningfully reject one step while
  approving the one next to it.
- Each step ends at something you could independently check — a test that
  passes, an endpoint that answers, a column that renders.

A step you cannot state a check for is either two steps or none.

## Each step names what it builds — in `what` and `files`

The plan's steps carry `{ n, what, files, layer }`. There is no field for an
interface, so the interface lives in `what`:

- **`what` names the exact symbols** the step adds or changes — the function and
  its signature (parameters and return type), the model and its fields, the
  component and its props, the constant and its value, the endpoint and its
  route. If step 3 produces a helper that step 6 calls, step 3's `what` states
  its name and signature and step 6's `what` calls it by that same name.
- **`what` carries the real rule, not a gesture at it.** "Reject the write when
  the target is not a Deel-salary person" — never "add validation". "Key the row
  on `entry.id`" — never "handle the list correctly". The value, the field, the
  condition, spelled out.
- **`files` lists every path the step touches**, because code reads it:
  `planForecast` picks implement's standards from `steps[].layer`, and the
  review gate scopes itself to `steps[].files`. A file left off a step is a file
  nobody is scoped to.

## No placeholders

These are plan failures. A step containing one is not done:

- "TBD", "TODO", "implement later", "wire it up".
- "Add appropriate error handling" / "add validation" / "handle edge cases" —
  name the error, the rule, the case.
- "Update the tests" with no statement of what the test now asserts.
- "Same as step N" — state it again; the executor may read steps out of order
  and a sub-agent sees only its own.
- A symbol, type or helper used in one step and defined in none.

## Verification travels with the step

For every acceptance criterion the ticket carries, point to the step whose
deliverable meets it, and record that mapping in `acceptanceCoverage`. The next
phase writes the test cases from those same criteria and `verify` executes them
— a criterion no step covers becomes a failing case, not a saved step. Where a
step's deliverable is itself a test (a new endpoint, a calculation), say in
`what` what the test asserts and what proves the step done.

## Self-review before you finish

With the ticket and its criteria in front of you, read the plan back once:

1. **Coverage.** Every acceptance criterion maps to a step. Every item
   `change-scoping` left in `openQuestions` or `reuse` that a step depends on is
   actually consumed by a step. List any gap and close it with a step.
2. **Name consistency.** A symbol defined in an early step is called by that
   exact name in later steps. A helper `get_other_teams_count_map` in step 1 and
   `other_teams_counts` in step 5 is a bug the executor will reproduce.
3. **Placeholder scan.** Re-read every `what` against the list above.

Fix inline; do not re-review.

## This phase is autonomous

The superpowers original ends by asking a human which execution method to use
and waiting for approval. Here there is none to ask: a deterministic conductor
runs the next phase, and the pipeline's own plan, design and test-case gates are
the human review. So produce no execution-method question and no handoff
prompt — the plan artifact IS the handoff.

One rule from `change-scoping` governs here too: **all steps ship unless an
`openQuestions` entry says a particular one may be dropped**, with its default
stated. Never leave a step the executor is free to skip on its own authority.

## Do not

- Do not decide scope, placement, reuse or consumer counts — that is
  `change-scoping`'s job, and it already ran.
- Do not invent a plan field; the interface goes in `what`, the paths in
  `files`.
- Do not write a step you cannot state a check for.
- Do not leave a placeholder, or a symbol no step defines.
- Do not add an execution-method question or a human-approval handoff.
- Do not write or modify any code.
