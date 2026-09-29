# Why a real bug fails to reproduce

Six reasons a defect that genuinely exists comes back `not-reproduced`, from the
QA team's own history. Walk this list **before** recording that verdict — it is
the one that can close a real ticket.

Most are false negatives, not near misses: the bug was there, the run looked
straight at it, and the conditions were wrong. The last one runs in **both**
directions — it also manufactures a discrepancy that is not a defect at all.

---

### 1. You are a superuser and the bug is about permissions

**The most common cause by a distance.** The test accounts carry superuser
access, so anything gated on a role, a permission or a group behaves *correctly*
for you and wrongly for the person who reported it. Nothing is visibly broken,
because nothing is denied to you.

A permission ticket also has two sides, and one of them is easy to skip: that the
right person **can** act, and that the wrong person **is stopped**. Reproducing
only the first proves half of it.

**Do:** before `not-reproduced` on anything touching visibility, access, or an
action being allowed — confirm the account's role matches the one the ticket
names, and that it is not a superuser. No non-superuser account available is
`inconclusive` with `blocker: access`, never `not-reproduced`.

### 2. The record is not the record the bug needs

The steps ran, the screen loaded, nothing looked wrong — on a record that does
not have the property the defect depends on. A different row of the same table is
not the same test.

**Do:** name the record's required shape in the plan, find one with a targeted
query, and say which record you used. If none exists here, that is
`blocker: data`.

### 3. Long content means one long WORD, not a long sentence

A layout bug that needs "long content" usually needs a single unbroken token — a
URL, a long email address, an identifier with no spaces. Ordinary long prose
wraps and looks fine; one long word cannot wrap, and that is what overflows the
cell, pushes the column, or clips the row.

**Do:** reproduce with a real unbroken string, not lorem ipsum. Paste a URL.

### 4. The bug is in the edit path, not the create path

Fill the form, submit, it works. Fill it, **edit a field, then submit** — and it
fails. The defect lives in the transition, not the initial state: stale values,
a dirty-form flag, validation that only runs on first render.

**Do:** where a ticket involves a form, run both orders before concluding
anything. Submitting directly once is not a reproduction of a bug reported on a
form that was changed.

### 5. Money is rounded on screen and exact underneath — the only one that cuts both ways

On costing and report screens amounts show as whole dollars, or as floats rounded
to two decimal places. The backend calculates at full precision, to however many
places the arithmetic produces. That creates two opposite mistakes:

- **A discrepancy you "reproduce" by comparing a screen value against an API or
  DB value is not the bug.** Those two numbers differ by design. Reproducing a
  reported "wrong total" that way is a false `reproduced` — it will be there on a
  perfectly correct build.
- **A genuine rounding bug only appears at scale.** Over a short date range the
  drift is under a cent and invisible; over a long one it accumulates, and a
  report pulled across a wide filter comes out $2–3 apart. Run it over a narrow
  range and a real defect records as `not-reproduced`.

**Do:** compare like with like — screen against screen, or raw against raw, and
say in `observed` which you used. Where the ticket reports a discrepancy over a
period, use **that** period, not a convenient short one. A difference of a few
dollars across a wide date filter is the shape this bug has; treating it as noise
loses it, and treating rounded-vs-exact as the bug invents one.

### 6. The conditions were not the ticket's conditions

The environment, browser, viewport, period or account you used differed from the
one reported, and the difference is the bug. Already in the skill's rules, and it
is what the five above are each a specific instance of.

**Do:** state the conditions you ran in `reason`, so a reader can see which one
differed from the report.

---

## How these get caught

Not by re-reading the code — by asking, of a `not-reproduced`: **whose account,
which record, what content, which order, over what range, rounded or raw?** Every
entry above is a different answer to one of those, and each was found the same
way: someone re-ran it under the reporter's conditions and the bug appeared
immediately.

## Adding to this file

An entry earns a place when a reproduction said `not-reproduced` (or
`reproduced` for the wrong defect) and a person later showed otherwise. Write
the class, not the ticket — "long content means one long word" fires on a screen
nobody has seen yet; "ticket #123's link was too long" does not.
