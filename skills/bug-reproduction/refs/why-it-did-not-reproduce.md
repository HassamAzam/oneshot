# Why a real bug fails to reproduce

**One principle: you ran it under different conditions than the reporter, and the
difference is the bug.** Below are the six conditions that differ most often,
from the QA team's own history. Walk them before recording `not-reproduced` —
that is the verdict that closes a real ticket.

---

### 1. The account

A session running as a superuser sees anything gated on a role, permission or
group behave correctly for it and wrongly for the reporter. **The most common
cause by a distance.** A permission ticket also has two halves — the right person
can act, the wrong person is stopped — and reproducing one proves half of it.

**Do:** read the account's actual flags and permissions, and record them. Not
"logged in as the test user" — `is_superuser`, `is_staff`, and the specific
permission the view requires. An account you cannot confirm is not a tested
account, and no suitable account at all is `inconclusive` / `blocker: access`.

**Read them, do not assume them.** This file once asserted what the configured
test login was without looking, and was wrong. A guess about the account
propagates into every verdict that account produces, in the expensive direction:
it writes off a whole ticket class as unreproducible, and makes a genuine
permission reproduction look untrustworthy. The flags are one query away; the
assumption is never worth it.

### 2. The record

The screen loaded and nothing looked wrong — on a row that lacks the property the
defect depends on. A different row of the same table is not the same test.

**Do:** name the record's shape in the plan, find one with a targeted query, say
which you used. None here is `blocker: data`.

### 3. The content

Two shapes, and they fail for different reasons:

- **More characters than the display was built for.** A field accepts 1200
  characters where the view box was sized for 1000. It looks correct while
  typing — the defect appears only **after saving**, when the stored value is
  rendered back and the overflow has nowhere to go and no scrollbar.
- **One word wider than the field.** A link or an unbroken identifier has no
  break opportunity, so it cannot wrap and overlaps out of its container. Prose
  of the same total length wraps and looks fine.

**Do:** for the first, exceed the limit, **save, and re-open** — typing it is not
reproducing it. For the second, paste a real URL, not lorem ipsum.

### 4. The order

Fill the form and submit: works. Fill it, **edit a field, then submit**: fails.
The defect is in the transition — stale values, a dirty-form flag, validation
that only runs on first render.

**Do:** run both orders before concluding anything.

### 5. The precision — the one that cuts both ways

Costing and report screens show whole dollars or two decimal places; the backend
calculates at full precision. One fact, two opposite errors:

- **False `reproduced`:** a screen value compared against an API or DB value
  differs *by design*. That discrepancy is there on a correct build.
- **False `not-reproduced`:** the drift only accumulates at scale. Under a narrow
  date filter it is sub-cent; across a wide one it reaches $2–3.

**Do:** compare like with like — screen against screen or raw against raw — and
say which in `observed`. Use the period the ticket reports, not a shorter one.

### 6. The option — when the input is one of a fixed set

A filter, dropdown, band, status or role takes one of a few values, and the
ticket names one of them. You selected it, the screen was right, and you wrote
`not-reproduced`. But the code behind the control is **one** implementation
shared by every option: a fault in it is not specific to the option the reporter
happened to use. Only its *visibility* is — the symptom appears solely where a
record exists that can expose it.

This has already happened on a range filter here: the option the ticket named
returned correct rows throughout, and the fault showed on a neighbouring one. The
shape is general — where a filter compares two computations of the same quantity,
the mismatch is only visible on an option that some record's two values straddle,
and an option whose records all agree looks correct on a broken build.

**Do:** before concluding anything, run every option, not the named one. Then
derive which option *can* show it — find a record where the two computations
disagree and select the option its values straddle — instead of trusting the one
in the ticket. A reproduction on a different option is still a reproduction of the
same defect: say which option showed it, and say plainly that the ticket's own
illustration does not occur, or the fix lands on that one option and the
mechanism stays broken.

---

## How these get caught

Ask of any `not-reproduced`: **whose account, which record, what content, which
order, over what range, rounded or raw, and which of the options?** Each entry is
one answer.

## Adding and retiring

An entry earns its place by **changing a verdict**. Write the class, not the
incident — "long content means one long word" fires on a screen nobody has seen
yet; "the link on that payroll ticket was too long" does not.

Retire one the same way. If no reproduction has cited an entry and no `blocker`
in the run telemetry matches its cause, it is not firing. An entry nobody has
used is furniture, not knowledge.

**State the class in the entry and keep the case in Sources.** This file is
injected into every reproduction session, so a worked example naming the ticket,
the option and the records is an answer key for the run that is about to derive
them. Cite the ticket; do not solve it here.

## Sources

Ticket numbers are not unique across projects, so each is cited by full URL.

- Conditions 1–5: the QA team's own history, collected rather than drawn from one
  ticket.
- Condition 6, and the correction to condition 1:
  [erp#8771](https://gitlab.arbisoft.com/arbisoft/erp/-/work_items/8771).
