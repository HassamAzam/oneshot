---
name: local-browser-verify
description: Bring a checkout's app up on a leased port and execute an existing test-case list against the real UI with Playwright. Use when asked to "verify this locally", "run the cases in a browser", "does this actually work in the app", "check the change end to end before the MR", or when Oneshot's phase 6 runs. Executes a list somebody else wrote — does not author cases and does not fix the code it breaks.
---

# Local Browser Verify

Execution, not authorship. The case list is an input. You establish what is true
about this branch, in a browser, and record it.

## Bring the app up first

Start the server before you read anything else — the first compile is the long
pole and it can run while you study the cases.

- **One process, one origin.** `PORT=<leased> npm start` from the worktree
  serves the frontend and the backend together; `http://localhost:<leased>/` is
  the entry point. There is no separate API port. The leased port is in
  `ONESHOT_PORT`; never pick your own — another run holds the others.
- **It must be a server YOU started from THIS worktree.** The leased port is
  handed to you free. If something already answers on `ONESHOT_PORT` before you
  start your own — a foreign dev server, an orphan from a crashed run — do NOT
  drive it. It is almost certainly a different checkout, and then every value
  you record is about the wrong code while reading green. Confirming "HTTP 200"
  is not confirming it is *your* build. Start your own; if the port cannot be
  freed, report it occupied and stop rather than verify a stranger's server.
- **Not `manage.py runserver`.** That serves the backend alone and exists for
  Odoo-wired one-offs.
- **Point the frontend at the leased port** in `frontend/src/constants/config.js`
  before starting. It is a seeded *copy*, so editing it cannot touch the seed
  repo, and it is in `.git/info/exclude`, so it cannot reach a commit.
- **Never `npm ci`, never rebuild the venv.** `node_modules` and `venv` are
  symlinks into a working repo. Reinstalling rewrites that repo's dependencies
  for every other worktree on this machine.
- **Detached start needs stdin held open:** `tail -f /dev/null | npm start`.
- **The first webpack compile takes tens of minutes; incremental rebuilds take
  seconds.** Poll a readiness URL on an interval and keep waiting. Silence is
  not failure and a blind `sleep` is not a readiness check. Report the wait; do
  not abandon it early and call the phase blocked.
- **Run migrations before the first request** whenever the change added any.

## Log in like a user

Through the real login form, with the seeded settings' credentials. Never stub
auth, never inject a session cookie, never route around the login screen — half
the bugs worth finding live in what the logged-in user is allowed to see.

`/admin` is available if you need to reset a password or find an account's
email.

## Drive it with Playwright

**Playwright only. Never Jest.** The Jest harness in these repos is rotted —
Babel drift, a missing enzyme adapter, ESM transform gaps — CI never runs it,
and hours have already been lost trying to repair it. Do not try again. Backend
pytest is unaffected and is fine to run.

- Playwright is **not** in the worktree's symlinked `node_modules`. Resolve it
  explicitly from the Oneshot repo's install (`NODE_PATH`, or an absolute
  `require`/import of that path). The chromium build it needs is already on the
  machine.
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

## Teardown

Kill the server you started. Leave one you inherited running if a later phase
needs the port. Free the port either way — the next run's verify is waiting on
it.
