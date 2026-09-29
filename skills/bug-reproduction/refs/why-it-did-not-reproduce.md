# Why a real bug fails to reproduce

**One principle: you ran it under different conditions than the reporter, and the
difference is the bug.** Below are the five conditions that differ most often,
from the QA team's own history. Walk them before recording `not-reproduced` —
that is the verdict that closes a real ticket.

---

### 1. The account

Test accounts are superusers, so anything gated on a role, permission or group
behaves correctly for you and wrongly for the reporter. **The most common cause
by a distance.** A permission ticket also has two halves — the right person can
act, the wrong person is stopped — and reproducing one proves half of it.

**Do:** confirm the account matches the ticket's role and is not a superuser. No
non-superuser account available is `inconclusive` / `blocker: access`.

### 2. The record

The screen loaded and nothing looked wrong — on a row that lacks the property the
defect depends on. A different row of the same table is not the same test.

**Do:** name the record's shape in the plan, find one with a targeted query, say
which you used. None here is `blocker: data`.

### 3. The content

"Long content" usually means one long *word* — a URL, an unbroken identifier.
Prose wraps and looks fine; a single token cannot, and that is what overflows the
cell or clips the row.

**Do:** paste a real URL, not lorem ipsum.

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

---

## How these get caught

Ask of any `not-reproduced`: **whose account, which record, what content, which
order, over what range, rounded or raw?** Each entry is one answer.

## Adding and retiring

An entry earns its place by **changing a verdict**. Write the class, not the
incident — "long content means one long word" fires on a screen nobody has seen
yet; "the link on that payroll ticket was too long" does not.

Retire one the same way. If no reproduction has cited an entry and no `blocker`
in the run telemetry matches its cause, it is not firing. An entry nobody has
used is furniture, not knowledge.
