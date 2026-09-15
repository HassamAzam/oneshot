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
- **Never `npm ci`, never rebuild the venv.** `node_modules`, `venv` and
  `staticfiles` are symlinks into a working repo. Reinstalling rewrites that repo's
  dependencies for every other worktree on this machine.
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
  script, `require` it through that path. Never `npm install` it into a worktree —
  that rewrites the shared `node_modules` for every other worktree on the machine.
- Prefer real data. Intercept `**/api/v1/**` only for a state real data cannot
  produce, and say in the evidence that the state was mocked.
- Retry a flaky step twice with a bounded timeout. Playwright flake is the
  largest source of false failures here. Passed on retry is a pass, with the
  retry noted; still failing after retries is a fail.
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

## Record one result per case

- Every case id from the list gets a result: pass, fail, blocked, or skipped.
  A silently omitted case is worse than a failing one.
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
