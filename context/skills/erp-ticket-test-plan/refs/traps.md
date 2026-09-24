# Traps — edge cases QA has had to ask for

Every entry here was a revision request on a real ticket: a case that failed on a
correct build, passed on an unchanged one, or was never written at all. Walk this
list before you present a plan, and again before you re-present a revised one.

Each entry is generalised past the ticket that produced it — the point is to catch
the same shape on a different screen, not to re-run one ticket's cases. `Learned
from` is there so an entry can be audited and deleted when it stops being true.

---

## A. Cases that FAIL on a correct build

### A1. Text the DOM holds is not the text the screen shows
A label stored in title case and capitalised by a display rule reads `Processed`
in the DOM, not `PROCESSED`. A check written from the screenshot fails on a build
where nothing is wrong, and a count of elements whose text is exactly `PROCESSED`
matches nothing, ever.

**Instead:** compare case-insensitively, or assert the stored wording and the
capitalising rule as two separate things. The same applies to trimmed whitespace,
truncation with an ellipsis, and number/date formatting.
*Learned from: workstreamai#259 (TC-02, TC-03, TC-04, TC-05, TC-10, TC-17)*

### A2. The list is paginated and your count is not
Comparing an on-screen count against a total the interface reports for the whole
period fails whenever the period holds more rows than one page. The listing loads
20 at a time.

**Instead:** either load every page before counting — the infinite-scroll case
already shows how — or count only the rows actually rendered and say so.
*Learned from: workstreamai#259 (TC-04)*

### A3. A command that needs environment setup, run bare
The linter cannot parse a source file unless the development environment setting
is exported first, exactly as the project's own pre-commit script does. Run bare it
exits non-zero on every file, including correct ones — and if that command is the
case's only runner, the case can never pass.

**Instead:** name the command the way the project's own scripts invoke it. Check
how the repo runs it before writing a case around it.
*Learned from: workstreamai#259 (TC-12, TC-21)*

### A4. A case that contradicts a conditional step in the plan
The plan said to delete a style key *unless* another consumer turns up. A case
demanding zero matches for that key fails on the correct build where a consumer
existed and the implementer correctly left it.

**Instead:** when a plan step has a branch, the case records **which branch
happened** and asserts the no-regression claim either way. Never hard-code one arm
of a decision the plan deliberately left open.
*Learned from: workstreamai#259 (TC-18)*

### A5. Measurements compared across two page loads
Recording an element's horizontal position on one month and comparing it against
the same measurement on another adds a difference that has nothing to do with the
change. It also fails to say *which* row was measured when one such element exists
per row.

**Instead:** compare within a single page load, between two rows in the same
table, and name the row by something stable.
*Learned from: workstreamai#259 (TC-04)*

### A6. A known pre-existing failure left in the setup
The unfiltered people list raises a documented server error for anyone with no
employment type recorded, and the team works around it by always applying an
employment-type filter. A case that lands on the unfiltered list inherits that
error.

**Instead:** put the known workaround in the pre-condition, and pin the case to a
named period rather than accepting "empty or populated".
*Learned from: workstreamai#259 (TC-08)*

---

## B. Cases that PASS on a build where nothing changed

A case that passes before the change tests nothing. Ask of every case: *would this
still pass if the diff were reverted?* If yes, it is a smoke check — keep it, but
label it and add a positive control.

### B1. Absence-only assertions
"No badge appears here" is already true on a build with no badge feature at all,
and "unprocessed rows are not blurred" was already true before the blur was
removed.

**Instead:** keep the case, call it a smoke check, and require a positive control
in the same table — a row that *does* render the thing — so the absence is proved
against a build where presence is possible.
*Learned from: workstreamai#259 (TC-06, TC-08, TC-11)*

### B2. A filter condition nothing can satisfy
Counting only badges whose text is exactly `PROCESSED` (see A1) returns zero on
every build, so a "zero badges" expectation is met even where the feature is
broken.

**Instead:** count the real population, then assert the property of it.
*Learned from: workstreamai#259 (TC-04)*

### B3. Asserting unchanged behaviour on untouched code
A permission case rated high blast asserted behaviour on code the ticket does not
touch. It passes identically before and after and evidences nothing about the fix.

**Instead:** keep it if it guards a real regression path, but rate it by what it
proves about *this* diff — high blast belongs on the lines actually being edited.
*Learned from: workstreamai#259 (priority note)*

---

## C. States nobody looked at because something was hiding them

This class produced the most-missed cases. When a change **removes** a visual
de-emphasis — a blur, a disabled look, a muted colour, a collapsed row — it does
not just change appearance. It exposes states that were always reachable and
never examined.

### C1. The action the de-emphasis was discouraging
Processed rows were always selectable: the row checkbox has no disabled gate and
select-all includes them. The blur was the only thing discouraging a second
increment email. Remove the blur and those rows look exactly as actionable as
every other one.

**Instead:** when a change removes a visual barrier, write the case for the action
the barrier was hiding — performed both individually and through any select-all
path — and assert what the system does on the repeat.
*Learned from: workstreamai#259*

### C2. Duplicate rows for one entity
Sorting by a per-row timestamp with `.distinct()` cannot collapse two rows that
differ in it, so one person can hold a forwarded row and a processed row in the
same listing. That was half hidden while one of them was blurred.

**Instead:** ask whether one entity can appear twice in the listing under test,
and if it can, write the case for it.
*Learned from: workstreamai#259*

### C3. The surviving half of a two-part requirement
The original requirement was "send at bottom **and** blur out". This ticket
reverses the blur, which makes the sort the only surviving half — and the plan's
justification for removing the blur rests on the sort still serving that intent.
No case asserted the sort; one merely assumed it to locate rows.

**Instead:** when a change reverses part of an older requirement, find that
requirement and assert the part that survives. An assumption used for setup is not
an assertion.
*Learned from: workstreamai#259 (TC-07)*

### C4. Combined states the code cannot produce
A row can never be both forwarded and processed: the listing derives the two from
mutually exclusive conditions. No setup produces it, so a tester logs a false
blocker or invents a pass.

**Instead:** check the deriving conditions before writing a combined-state case.
Where the branch exists only defensively, assert the **helper** directly for the
input and note the branch is unreachable through the UI.
*Learned from: workstreamai#259 (TC-12)*

---

## D. Expected values that are not measurements

### D1. Legibility asserted in adjectives
"Legible, visible, not washed out" is passed by a tester on a badge whose measured
contrast is 2.8:1 against the 4.5:1 a body-size label needs.

**Instead:** put the measured figure and the threshold in the expected result. If
the shortfall is knowingly accepted, say so in the case rather than letting a pass
imply compliance.
*Learned from: workstreamai#259 (TC-03)*

### D2. A stated cause nobody verified
A case explained a broken toolchain by saying no lock file is tracked. True, but
not the cause — the manifest pins the version exactly, so producing a lock file
changes nothing, and a reader following that explanation loses a cycle.

**Instead:** state a cause only if you checked it. "Cause not established" is a
better line than a confident wrong one.
*Learned from: workstreamai#259 (TC-12, TC-21)*

### D3. Known-broken tooling described at the wrong scale
Two cases put the broken unit-test toolchain at "21 unrelated suites" when in fact
every suite in the repository fails — 189 of 189, including the new tests the
change itself adds.

**Instead:** state the true scale, so a tester meeting a wall of failures does not
read it as new breakage. See also A3.
*Learned from: workstreamai#259 (TC-12, TC-21)*

---

## E. Fixtures and file lists that rot

### E1. Hard-coded period and count in the setup
A named month plus an exact number of processed people rots the moment any later
email changes that state — and the case that sends the email is the one producing
it.

**Instead:** derive the period and the row from the listing itself, or seed the
state in the case rather than assuming it.
*Learned from: workstreamai#259 (TC-01)*

### E2. A file list that does not match the diff
Cases filtered the console to errors from "the four files this ticket changes".
The change touched six; the list named one file that was not changed and omitted
two that were, so an error from either would have been filtered away unseen.

**Instead:** build the file list from the actual diff. Keep an unmodified file in
the list only deliberately, and say why it is being watched.
*Learned from: workstreamai#259 (TC-06, TC-08)*

### E3. A new helper with no direct check
When a change adds a helper and a file to hold its tests, nothing may assert the
helper itself for the states that actually occur. A check at that level is
repeatable, needs no seeded data, and cannot pass on a build where the helper does
not exist.

**Instead:** when the diff adds a helper, add a case that asserts it directly for
each state it can return.
*Learned from: workstreamai#259 (TC-21, added)*
