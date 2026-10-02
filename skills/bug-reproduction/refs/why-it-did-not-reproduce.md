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

**Read them, do not assume them.** `ONESHOT_TEST_LOGIN` was asserted here to be a
superuser, and it is not: on erp#8771 it resolved to `is_superuser=False`,
`is_staff=True`, 57 permissions, holding exactly the `core.pod_member` the view
required — so the permission gate was genuinely exercised. A guess about the
account propagates into every verdict that account produces, in the expensive
direction: it makes a real permission reproduction look untrustworthy.

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

erp#8771 is the case. The ticket said the Experience filter `1-2 Years` returns
people with 17–19 years. Band 1 returned 15 people and every one was correct, so
the ticket's literal claim does not occur on that database. The defect is real and
shows on `2-4 Years`, with two of the people the ticket itself names — because the
fault needs a record whose two calculations land in *different* bands, and band 1
contained none while band 2 did.

**Do:** before concluding anything, run every option, not the named one. Then
derive which option *can* show it: find a record where the two computations
disagree and select the option its values straddle, instead of trusting the one
in the ticket. A reproduction on a different option is still a reproduction of the
same defect — say which option showed it, and say plainly that the ticket's
illustration was wrong, or the fix lands on one band and the mechanism stays
broken.

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
