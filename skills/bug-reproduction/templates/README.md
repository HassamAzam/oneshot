# Ticket comment templates

The conductor posts one of these on the ticket (`src/conductor/reproduction.ts`
fills them in; the session never posts):

| Verdict | Template | The run |
|---|---|---|
| `reproduced` | `reproduced.md`, as soon as research returns | carries on to planning |
| `not-reproduced` | `not-reproduced.md`, once a QA reviewer comments `approved` on the Not a Bug gate | stops, ticket labelled Not a Bug |

`inconclusive` and `not-applicable` post nothing. The Not a Bug gate's own request
(the evidence plus how QA answers) is not a template: the conductor writes it, since
its wording belongs to the gate rather than to this skill.

Every value comes from the `reproduction` block in research.json, so what the
comment can say is limited by what you record there:

| Placeholder | Filled from |
|---|---|
| `{{reason}}`, `{{expected}}`, `{{observed}}`, `{{account}}` | the matching field |
| `{{commit}}` | `testedCommit` |
| `{{steps}}` | `steps`, numbered |
| `{{measurements}}` | `evidence` entries that are not `.png` |
| `{{screenshots}}` | `evidence` entries ending `.png`, found in the run's artifacts dir and uploaded (first 3) |
| `{{labelClause}}`, `{{labelRef}}`, `{{entryLabel}}`, `{{runId}}` | the conductor (not-reproduced only) |

A placeholder with nothing to say renders empty. When no screenshot is attached,
the comment says so in place of the images.
