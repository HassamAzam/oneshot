---
name: local-browser-verify
description: Bring a checkout's app up on a leased port and execute an existing test-case list against the real UI with Playwright. Use when asked to "verify this locally", "run the cases in a browser", "does this actually work in the app", "check the change end to end before the MR", or when Oneshot's phase 6 runs. Executes a list somebody else wrote — does not author cases and does not fix the code it breaks.
---

# Local Browser Verify

Execution, not authorship. The case list is an input. You establish what is true
about this branch, in a browser, and record it.

## Bring the app up with one command. Do not do it by hand.

```
node $ONESHOT_HOME/scripts/app.cjs ensure --ref <branch|!MR|#PR|sha>
```

That is the front door, and it is the one to use. It asks the question
`harness.cjs up` cannot — *is an app already running on this machine, and is it on
my code?* — and takes whichever path applies: reuse an instance already on that
commit (~3s), check the ref out into a clean instance we own and restart Django
(~11s), or seed a worktree and cold-start (~2min, measured). All three write the
same `state/runs/<iid>/harness/app-env.json`, so never branch on which one ran.

`harness.cjs up` still exists and still does the starting; it just cannot see an
instance belonging to another run, which is how four orphaned server pairs came to
be live on one machine while every new session still paid a cold start. Call it
directly only when you have been handed a worktree and told which ports to use.

It is idempotent either way: if the app is already up it reuses it.

**Everything below the command is context, not a procedure.** The harness already
does it. If `up` fails it returns a named code (`E_PORT_BUSY_FOREIGN`,
`E_WEBPACK_DEAD`, `E_DB_UNREACHABLE`, …) and a hint. Report that code. Do not
start improvising a bring-up of your own — every run that did spent between a
third and four fifths of its budget on it and several never reached a test.

What the harness knows, and why each fact cost a run to learn:

- **The app is TWO processes, and you navigate to Django.** `npm start` is
  webpack-dev-server alone. Django serves the SPA for every route through a
  catch-all (`hrdb/urls.py:93`), so one origin answers for the whole app. The
  webpack port is never navigated to; it only serves the bundle.
- **Use the hostname `localhost`, never `127.0.0.1`.** `ALLOWED_HOSTS` does not
  carry the bare address, so the IP returns 400 from a perfectly healthy server.
- **Readiness is `static/webpack-stats.dev.json` reaching `"status":"done"`**, not
  a log line. That file is written once at the start of a compile and again at the
  end, and Django raises a bare 500 on anything but `done`. A `Compiled
  successfully` from an earlier build stays in the log forever.
- **Django runs `--noasgi`.** With Channels' ASGI dev server, a browser's
  keep-alive connections exhaust it and the process then keeps its pid and its
  socket while answering nothing at all.
- **Websockets are blocked in the browser.** They carry reminders and mood cards,
  nothing under test, and they are the other half of the wedge above.
- **It must be a server YOU started from THIS worktree.** The harness verifies the
  listener's working directory. Confirming HTTP 200 is not confirming it is *your*
  build — a phase that drove a stranger's server recorded every value against the
  wrong code while reading green.
- **An install is refused, not discouraged.** `node_modules`, `venv` and
  `staticfiles` are symlinks into a working repo, so reinstalling rewrites that
  repo's dependencies for every other worktree on this machine. `install-guard`
  denies `npm ci`/`install`, `npx`, a venv rebuild and `rm -rf node_modules`
  outright. What is left to you is the reading: a module that will not resolve is
  an environment fault worth `blocked`, not a problem to work around.
- **`staticfiles/` must be seeded or Django 500s on every page.** local_settings.py
  ships DEBUG=False with ManifestStaticFilesStorage, so `{% static %}` raises
  `Missing staticfiles manifest entry` until collectstatic has run — including on
  `/admin/login/`, which is this harness's own readiness probe. Every fresh worktree
  died as `E_DJANGO_DEAD` after the full 90s Django budget until 2026-09-10.
  `app.cjs ensure` collects it in the seed repo if it is missing (5s, once).
- **A detached dev server needs `CI=true`.** `frontend/scripts/start.js` exits when
  stdin closes unless that is set, which is why detached starts died silently and
  phases then polled a dead port for minutes. The harness sets it; the old
  `tail -f /dev/null | npm start` workaround is no longer needed.
- **The first webpack compile takes tens of minutes; incremental rebuilds take
  seconds.** Poll a readiness URL on an interval and keep waiting. Silence is
  not failure and a blind `sleep` is not a readiness check. Report the wait; do
  not abandon it early and call the phase blocked.
- **Run migrations before the first request** whenever the change added any.

## Log in, and reach a module

```
node .claude/skills/local-browser-verify/scripts/harness.cjs smoke        # up + login + two modules
node .claude/skills/local-browser-verify/scripts/harness.cjs goto <key>   # one module
node .claude/skills/local-browser-verify/scripts/harness.cjs modules      # the 46 known keys
```

Login goes through the real form with the credentials in `ONESHOT_TEST_LOGIN`.
Never stub auth, never inject a session cookie, never route around the login
screen — half the bugs worth finding live in what the logged-in user may see.
The harness saves the session, so later phases skip the form entirely.

Three things it handles that cost earlier runs their budget:

- **Never `waitForURL` after submitting.** The app navigates with `history.push`,
  a same-document transition, so the default wait never resolves. That is what
  stalled run 24's login until it timed out.
- **The verdict comes off the wire, not the DOM.** The error toast only renders
  when the token is empty, so a stale session made failures invisible.
- **A disabled submit button means the trial expired**, not a slow page. Force-
  clicking it hid that as a generic timeout.

`modules.json` carries the route and the assertion for each module, taken from
the components. Assert on `data-testid` only: several skeletons reuse the page's
`aria-label`, so an `aria-label` check passes while the screen is still a shimmer.

`/admin` is available if you need to reset a password or read an account's
groups. It takes a Django **username**, not an email — feeding it the email is a
mistake run 20 made and could not diagnose.

## Drive it with Playwright

**Playwright only. Never Jest.** The Jest harness in these repos is rotted —
Babel drift, a missing enzyme adapter, ESM transform gaps — CI never runs it,
and hours have already been lost trying to repair it. Do not try again. Backend
pytest is unaffected and is fine to run.

- Playwright is **not** in the worktree's symlinked `node_modules`. The harness
  resolves it from the Oneshot repo's install for you; if you write your own
  script, `require` it through that path or through `NODE_PATH`. Installing it
  into a worktree is denied by `install-guard`, so resolving it correctly is the
  only route there is.
- Prefer real data. Intercept `**/api/v1/**` only for a state real data cannot
  produce, and say in the evidence that the state was mocked.
- Retry a flaky step twice with a bounded timeout. Playwright flake is the
  largest source of false failures here. Passed on retry is a pass, with the
  retry noted; still failing after retries is a fail.
- **Zero matches is a question, not an answer.** Before recording a failure on
  an element you could not find, prove the element is genuinely absent: dump the
  surrounding container's HTML and look for the same thing under a different
  name. The admin runs **Grappelli**, which prefixes every class and id with
  `grp-` — the save banner is `.grp-messagelist`, not `.messagelist`; the
  history table is `#grp-change-history`, not `#change-history`. A selector
  written from stock-Django docs matches nothing on a perfectly working page.
  Ticket 244 filed two working features as product bugs exactly this way and
  blocked the ticket for a week. If the feature turns out to work under a
  corrected locator, that is a **pass** with the correction noted. If the dump
  shows the element is genuinely absent under every name, that is a **fail** —
  the product is broken. A `locator` block is only for a case you could not
  express against this app at all, never for one you expressed and the page did
  not satisfy: nothing re-runs a blocked case and no gate reads one. Either way
  the dump's outcome goes in the case's `evidence` verbatim, one line per
  selector tried:

  ```
  selector '.messagelist li': 0
  selector '.grp-messagelist li': 1
  ```
- **Wait for data, not skeletons.** These reports paint MUI Skeleton
  placeholders while a drill-down's async call is in flight, and a modal's call
  can take tens of seconds on a cold DB. A fixed short wait reads the shimmer
  rows as empty and records a real, reconciling drill-down as all-null — the
  single largest source of phantom "total not synced" failures. Wait for the
  loading state to clear (the actual data cells present, or the network call
  settled) before reading any value.
- **Read cells by column header, never by position.** These tables are wide and
  horizontally scrolled, so a hard-coded column index silently lands on the
  wrong column. Never sum a percentage or utilization column as if it were cost:
  a "drill-down total" that comes out near 200 is a utilization column adding to
  ~100% per head, not money — check the header before you compare it to a cell.
- **Measure a visual bug after the interaction, not on the tick of it.** "Obscured",
  "overlapping", "covers the field below" and "still open after selecting" are
  claims about geometry, and geometry has a number. Drive the interaction, let
  the overlay come to rest, then measure:

  ```js
  const h = require('<oneshot>/skills/local-browser-verify/scripts/harness.cjs');
  await h.overlap(session, '.react-datepicker-popper', '[name="training.end_date"]');
  // → { intersects: true, areaPx: 10352, region: { width: 242, height: 43 }, ... }
  ```

  The number is the area the two boxes share, and it is symmetric: a popper
  painted under the field and one painted over it return the same `areaPx`.
  When the ticket is about which one is on top, check that separately with
  `document.elementsFromPoint()` at the centre of `region`.

  Six ways this reads the wrong verdict, all of them paid for already:

  - **`areaPx` is an area, not a distance.** It is about
    `region.width * region.height`: each side of `region` is rounded on its own
    and `areaPx` from the unrounded product, so 10352 beside 242 × 43 (10406) is
    right — the band was 42.8px. Reported as "covered by 10352px" it reads as a
    length, and a length that large is impossible on a 900px-tall screen — so a
    reader reasonably assumes the measurement is broken and dismisses a real
    defect. Quote `region`, or the height it implies: 10352 over a 242px-wide
    popover is a 43px band, i.e. one input row. Say "px²" or "the whole Title
    row", never "10352 pixels".

  - **`boundingBox()` does not wait for the geometry to settle.** It returns the
    box as it is when asked. A popper re-anchors — it measures its reference,
    picks a placement, and flips it when that one does not fit — so consecutive
    reads during that negotiation gave y = 100, 220, 340, 460, 580, 700 with no
    transition involved at all. `overlap` settles both boxes first, and names in
    `unsettled` any side still moving when its `timeout` ran out. That side's box
    is a position it was passing through, so the result is a snapshot, not a
    measurement, whichever way it reads: re-measure with a longer `timeout`, and
    if it still will not hold still, record the case `blocked` and quote the `a`
    and `b` boxes each read returned, never the `areaPx`. On a hand-rolled check,
    poll until the box stops moving. A fixed `sleep` is not a settle. Do not lean
    on animation timing for this: a 0.2-0.3s CSS fade is frequently over before
    the first round-trip returns, so a naive read looks correct on a fast machine
    and wrong on a slow one.
  - **`intersects: null` is not "no overlap", and not a verdict on its own.** It
    means one side did not resolve a box, or resolved and then detached before
    it could be inspected, and `missing` says which. Which side decides what it
    means:
    - **Something that should be on screen** — the field you measure against,
      or the overlay before you dismiss it. That is the zero-matches question
      above, so run that procedure: dump the container and retry under other
      names. Re-measure under a corrected locator and judge the case on that
      reading, with the correction noted; an element proven absent under every
      name is a `fail`. Only a case you cannot express against this app at all
      is `blocked`, and to make `runCase` file it that way you have to throw a
      `HarnessError` — it files a plain `Error` as `fail`, which is a defect
      claim against a branch that may have nothing wrong with it:

      ```js
      throw new h.HarnessError('E_SELECTOR_EMPTY', `locator: ${res.missing} did not resolve`);
      ```

      `runCase` returns that message as `reason`, which is not a field of the
      case result. Copy it into the case's `evidence` — it already starts with
      `locator:` — followed by the dump's one line per selector tried.
    - **The overlay after a dismissal.** The one place null is the answer you
      want, and only behind a positive control: a popover absence-assertion
      passes identically whether dismissal works or the popover never opened
      at all, so prove the thing you expect to be there IS there before
      concluding the thing you expect to be gone is gone. The calendar bullet
      below shows the control.
  - **An element off-screen cannot overlap anything.** CSS `zoom` and a short
    viewport have put a real element at `top=1194px` in a 900px window, and a
    popper scrolled above the viewport sits at a negative `y`. `outsideViewport`
    is true when either box lies wholly past any edge; check it before believing
    a zero. `hidden` is the same guard for an element that kept its box but is
    not on screen — `visibility:hidden` and `opacity:0` both measure full size,
    so a popover that is hidden rather than unmounted would otherwise be
    reported as covering the field it no longer covers.
  - **Each side measures its selector's FIRST match.** A selector that also
    matches a parked copy measures whichever comes first in the DOM: on the live
    Training modal, `.MuiDialogContent-root` matched a hidden copy of the dialog
    left at y 1203..1497 and gave two readings that described nothing on screen.
    `hidden` or `outsideViewport` on a side you can see in the screenshot is
    this — narrow the locator until it matches the one on screen.
  - **Nothing here survives the page scrolling underneath it.** The two boxes are
    viewport-relative and read one after the other, so a scroll that lands
    between them compares two different frames: two elements 600px apart,
    truthfully `areaPx=0`, measured `areaPx=20000`. Let the scroll finish before
    you measure.

  Screenshot after the settle, not before — a shot timed one tick early omits the
  defect, and then the disproof and the proof look identical in `artifacts/`.

- **"The calendar covers the fields around it" is two different defects. Say
  which one you measured.** `.react-datepicker-popper` already carries
  `z-index: 99999` in `custom.css`, so a pixel count on its own does not name a
  bug, and whether a popover covering a field while it is open is a defect at
  all is the case's call, not this skill's. Two things produce that screenshot
  and they have nothing in common:

  - **It is still mounted after the selection.** The popper is still on screen
    once a date is chosen and the form has settled. Record that, and do not name
    a cause you did not observe: the focus race that reading react-datepicker's
    `sendFocusBackToInput` suggests does not hold up — `focus()` dispatches
    synchronously while its `preventFocus` guard is still set — and a re-open
    did not reproduce on the live Training modal in three runs.
  - **Where it opened.** A tall calendar (`showYearDropdown` +
    `scrollableYearDropdown`) asked for `popperPlacement="top-start"` lands on a
    neighbouring field while it is open: on the field above when it fits and
    never flips (10352 px² over Training Title, on the live Training modal), or
    on the field below when a modal has no room above and Popper flips it down.
    Placement, not dismissal.

  They are distinguishable, but only with a control. With the calendar open and
  before choosing a date, measure the popper against the field; then select a
  date, let the form settle, and measure again:

  ```js
  const popper = '.react-datepicker-popper';
  const field = '[name="training.end_date"]';
  const before = await h.overlap(session, popper, field);
  // select a date, let the form settle
  const after = await h.overlap(session, popper, field);
  ```

  `before` must come back with `missing` empty, `hidden` empty and
  `outsideViewport` false — any number, 0 included. That proves both selectors
  resolve to something a user can see on this screen. Resolving is not enough on
  its own: a popover kept mounted while hidden (MUI `keepMounted`, a fade-in that
  never ran) reads `hidden: [popper]` before and after alike, and the `hidden`
  reading below would then certify a dismissal of a calendar that never opened.
  If `before` fails, nothing `after` says can be read yet — stop:

  - `missing` names a side — run the zero-matches procedure.
  - `hidden` names the popper — the calendar never visibly opened, so there is
    nothing to dismiss. Check the step that opens it first (a click swallowed by
    a layout shift looks exactly like this); a calendar that will not open is
    the case's own question, and never a dismissal `pass`.
  - `hidden` names the field, or `outsideViewport` is true with the field's box
    (`b`) past the edge — you are measuring against something that is not on
    screen, usually a parked copy that matched first (see the first-match bullet
    above). Narrow the locator and re-measure.
  - `outsideViewport` is true with the popper's box (`a`) past the edge — it
    opened where the user cannot see it. That is placement, the case's own
    question; there is nothing on screen to dismiss.

  Then:

  - `after.intersects === null` and `after.missing` is exactly `[popper]` — the
    popper unmounted: it closed and stayed closed. Dismissal is a `pass`, and
    anything in the screenshot was placement while it was open (a defect only
    if the case says so).
  - `after.intersects === false` with the popper in `hidden` — it went from
    visible, which the control proved, to hidden rather than unmounted. Closed,
    for this purpose.
  - `after.missing` names the field — the field stopped resolving between the
    two reads. That is a locator question, not a dismissal verdict: back to the
    zero-matches procedure.
  - Any other number — the popper is still on screen after the selection.

  Record which of the two you saw, in those words: a verdict that says only
  "calendar overlaps end date by 9342px²" sends the fix at the z-index, which is
  already correct, and the real defect survives the MR.

## Record one result per case

- Every case id from the list gets a result: pass, fail, blocked, skipped, or
  pre-existing. A silently omitted case is worse than a failing one.
- **`fail` means the product misbehaved — nothing else.** A case you could not
  express correctly against this app is `blocked`, with `locator:` as the first
  word of `evidence`. A case whose account, record or screen does not exist here
  is `blocked`, with `fixture:`. Neither is a defect in the branch, and calling
  them `fail` stops a ticket that has nothing wrong with it.
- **`pre-existing` means the product misbehaved and this branch did not cause
  it.** It fails the same way on the base branch. Prove that in `evidence`:
  say you saw it on the base, or give the base `file:line` that produces it and
  confirm the diff does not touch it. It never applies to a case covering the
  ticket's own criteria, or to the bug the ticket reports: those fail on the
  base by definition. Oneshot refuses the label on a `happy`-tagged case, and
  re-runs every other `pre-existing` case on the base branch with a check that
  also judges scope; a case that does not fail there, or that the check finds
  in this ticket's scope, turns back into a `fail`. A confirmed one does not
  send the run back or block the merge; it is listed on the MR. If you are
  unsure, it is a `fail`.
- Evidence is **actual vs expected**, in the case's own terms — not "looks
  right".
- `skipped` requires a reason. `blocked` names the missing precondition.
- Screenshot every fail and every high-blast pass into the run's artifacts
  directory, named `<case-id>-<pass|fail>.png`. Record the bare filename.
- A regression — something that worked before this branch and no longer does —
  is reported separately from a case failure, because no case will be watching
  for it.

## Do not

- Do not fix the defect you found. A verify pass that also patches the code has
  destroyed the only clean signal about what the implementation actually did.
- Do not edit anything beyond what it takes to make the environment run.
- Do not reinterpret an `expected` you disagree with. Record the mismatch and
  say the case may be wrong.
- Do not declare the run green because the build compiled.

## Teardown — leave it running

**Do not stop the servers.** `ui-evidence` runs next, on the same worktree, and it
starts within two seconds of you finishing. When verify tore its own servers down,
that phase found a dead port every time and spent between a third and four fifths
of its budget rebuilding what had just been working; three of six died at the turn
cap before taking a screenshot.

The conductor reaps both processes by recorded pid when the run ends, and the
harness is idempotent, so leaving them up costs nothing and saves the next phase
its entire bring-up.

Run `harness.cjs down` only if you are told the run is finishing with you.
`node $ONESHOT_HOME/scripts/app.cjs gc --kill` reaps servers whose run is long gone,
and is the fix for a leased port that has nothing to do with you.
