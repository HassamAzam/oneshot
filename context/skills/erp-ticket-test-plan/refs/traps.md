# Test-case traps

A case that can fail for a reason the diff did not cause is worse than no case: it
burns a cycle, sends `implement` after work it cannot do, and blocks the gate on
something no diff can fix.

Seven principles. Each one is a rule about **authoring a case** — if applying it
needs a sentence about how the code should be built or how the repo should be
configured, it belongs to another phase.

---

### 1. Assert on product behaviour, not on toolchain state

A lint or test-suite run is a build step, not a case. If the runner is broken the
case fails correctly and tells you nothing about the diff.

- If a case's only assertion is "run X, expect a clean exit", it is not a case.
- Where a known-broken runner is unavoidable, state its true scale so a tester
  does not read a wall of failures as new breakage.

### 2. Assert on what you actually query, not on what the screen shows

The DOM and the rendered page routinely disagree.

- Text capitalised by a display rule is stored in title case: the DOM holds
  `Processed`, the screen shows `PROCESSED`. Compare case-insensitively, or assert
  the stored wording and the rule separately.
- `keepMounted` modals and drawers sit in the DOM at all times. `querySelectorAll`
  counts them; axe and a screen reader ignore them. Scope the query to the content
  container and name the known always-mounted nodes as expected.

### 3. What the case tells the tester must be checkable

- Adjectives are not measurements. "Legible, not washed out" passes on a badge at
  2.8:1 against the 4.5:1 a body label needs. Put the figure and the threshold in
  the expected result.
- Name what was measured. One element per row means the step must say which row.
- Compare within one render. Measuring the same element on two page loads adds a
  difference that has nothing to do with the change.
- State a cause only if you checked it. A note diagnosing the repo wrongly costs
  the tester a cycle chasing a fix that cannot work.

### 4. Counts and filters must match the page's real shape and the real diff

- The listing paginates. An on-screen count compared against a total the interface
  reports for the whole period fails on a correct build. Load every page, or count
  only what rendered and say so.
- A filter built from a guess hides what it should catch: one narrowed the console
  to "the four files this ticket changes" when six changed, so an error from either
  omitted file would have passed silently. Derive it from the diff.
- A filter nothing can satisfy passes everywhere. Counting elements whose text is
  exactly `PROCESSED` (see 2) returns zero on every build, broken or not.

### 5. If it would pass on the reverted diff, it proves nothing

Ask it of every case. A case that survives the revert is a smoke check — keep it,
label it, and give it a positive control.

- "No badge appears here" is already true before the badge feature exists. Require
  a row in the same table that *does* render one.
- Asserting unchanged behaviour on code the ticket does not touch passes
  identically before and after. High blast belongs on the lines being edited.

### 6. Removing what hid a state exposes states nobody examined

The most-missed class. A blur, a disabled look, a muted colour or a collapsed row
is not only appearance — it is what stopped anyone looking.

- Test the action the barrier was discouraging. Processed rows were always
  selectable; the blur was the only thing deterring a second increment email.
- Ask whether one entity can appear twice. A sort on a per-row timestamp with
  `.distinct()` cannot collapse two rows differing in it.
- Find the surviving half. When a change reverses part of an older requirement,
  assert the part that remains — an assumption used for setup is not an assertion.

### 7. Setup states its conditions, and records the decisions the plan left open

- Derive the period and the record from the listing, or seed them. A hard-coded
  month plus an exact count rots the first time anything changes that state.
- Put a known pre-existing failure's workaround in the pre-condition rather than
  letting the case inherit it.
- Where a plan step has a branch ("delete the key unless another consumer exists"),
  the case records which branch happened. Hard-coding one arm fails the build where
  the other was correct.
- Check the code can produce the state. Two conditions that exclude each other mean
  no setup reaches that row; assert the helper directly instead.
- When the diff adds a helper, assert it directly for each state it returns. That
  check is repeatable, needs no seeded data, and cannot pass where the helper is
  absent.

---

## Retiring an entry

Mutate the code a principle covers and re-run a case written from it. If the
verdict does not move, the case caught nothing and the entry is not earning its
place — delete it. An entry that has never changed a case is noise.

## Source

Principles 1–7 were distilled from four QA revision rounds on
[workstreamai#259](https://gitlab.arbisoft.com/arbisoft/workstreamai/-/work_items/259)
(*Remove blur on processed increment rows in review listing*). Ticket numbers are
not unique across projects — `erp#259` is an unrelated ticket — so cite new sources
by full URL.
