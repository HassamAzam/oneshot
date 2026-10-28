# Test-case coverage rubric

The single source of truth for what "covered" means in the `testcases-eval` evaluation.

This file is read in three places, and nothing else states the rule:

- `src/phases/prompts.ts` embeds it verbatim in the judge's prompt.
- A person labelling `gold.json` reads it to decide the same calls by hand.
- `src/conductor/schemas.ts` points at it instead of restating it.

A rule that appears anywhere else will drift from this one. Add to this file instead.

## The requirements are given

The requirement list is `research`'s acceptance criteria, numbered `AC1`, `AC2`, … in the order
research wrote them. The judge does not decide what the ticket requires; it decides, for each given
requirement, whether the list tests it. A requirement the judge thinks is wrong or missing is a
**finding**, not an edit to the list of requirements.

## Covered

A requirement is **covered** by exactly one case: the one whose precondition, steps and expected
result would **fail if the software got that requirement wrong**. Name that case id, or `none`.

Ask it as a counterfactual, not as a topic match: *if a developer broke this requirement and changed
nothing else, would this case go red?*

- Yes, and the expected result is what goes red → **covered**.
- Yes, but only because the case would not run at all (a precondition that cannot be built, a screen
  that no longer exists) → **not covered**. A case that cannot execute covers nothing.
- No → **not covered**, even when the case is about the same feature, the same screen or the same
  field.

If two cases would both go red, name the one whose *expected result* asserts the requirement most
directly. Coverage is one case per requirement, so the second one is not an alternative answer — if
it adds a boundary the first does not reach, that is a `missing` finding against the edge, not a
second coverage call.

## Not covered

These are the four ways a list looks covered and is not. Each is `none`.

**Visits the screen but asserts nothing about the rule.** `AC: a Reimbursed trip divides amount_paid
equally between participants.` A case that opens the expense, marks it Reimbursed and expects "the
page loads with no error" → **none**. It would stay green against any division.

**Asserts in the wrong state.** `AC: saving Amount Paid while the claim is In-Progress must not
rewrite the participant rows.` A case that saves Amount Paid *after* the Reimbursed decision and
expects the rows to update → **none**. It exercises the opposite state, so breaking the In-Progress
rule leaves it green.

**Asserts the neighbouring quantity.** `AC: the participants' amounts must sum to amount_paid, and
amount_paid itself must not change.` A case that expects each participant to hold 11,000 → covers
the per-head share, not the sum-and-unchanged-total rule. Against a bug that divides correctly and
then also edits `amount_paid`, it stays green → **none** for this requirement.

**Asserts the shape, not the value.** `AC: an Amount renders with at most two decimal places.` A
case that expects "an amount is shown" or "the column is not empty" → **none**. `expects: 145,635.26`
→ **covered**.

## A worked pair

Ticket: *thousands separators are being inserted inside the decimal part — 1,460,414.8,6 should read
1,460,414.86.*

```
AC1: An Amount renders with separators only in the integer part.

TC-04  precondition: a person whose benefit total is 1460414.86
       steps: open Payroll > People Report
       expects: the Amount column reads 1,460,414.86
→ covered by TC-04. A regression that commas the decimals renders 1,460,414.8,6 and TC-04 goes red.

TC-09  precondition: a person with a benefit total
       steps: open Payroll > People Report
       expects: the Amount column shows a formatted number with commas
→ none. "Formatted with commas" is true of 1,460,414.8,6 as well, so the bug leaves TC-09 green.
```

## Findings

A finding is what is missing or wrong, reported alongside the coverage calls. It is rated on three
axes, and only a `supported` + `in-scope` + `critical`-or-`major` finding is allowed to spend a
`testcases` re-run.

| Axis | Value | Means |
|---|---|---|
| validity | `supported` | The evidence given establishes it. |
| | `uncertain` | Neither the ticket nor the code settles what the behaviour should be. |
| | `unsupported` | Contradicted by the list or by the judge's own coverage calls. |
| relevance | `in-scope` | The ticket names it, or the change touched that code path. |
| | `out-of-scope` | Everything else, however real. |
| severity | `critical` | A given requirement (`AC*`) has no covering case. |
| | `major` | An evidenced edge on a changed path is uncovered, or a case expects behaviour the ticket contradicts. |
| | `minor` | Anything else. |

A `missing` finding about an edge that sits *under* a requirement you called covered must name that
covering case in `cases` and say in `gap` what it does not reach. Without that case named, a
`missing` finding against a requirement your own coverage call maps to a case contradicts itself,
and code discards it.

Never invent a business rule to make a finding `supported`. A behaviour the ticket is silent about
is `uncertain`, and `uncertain` is shown to a person instead of spending a re-run.

### Evidence

Every finding carries evidence, and it is checked mechanically — not for its argument, only for
whether the thing it points at exists:

- A **quote**: four or more words, copied from the ticket. Case, whitespace and markdown emphasis
  are forgiven, and `…` may elide words between fragments of two or more words each.
- A **`file:line`**: a path relative to the repo root, on or within ten lines of a line this change
  touched.

Evidence that does not check out makes the finding `uncertain`, whatever the judge rated it. The
requirements themselves need no evidence — they are given.

## Not a judgement about the code

The evaluation judges the **list**, never the implementation. "The code does not do this" is not a
coverage finding; a missing or wrong *case* is.
