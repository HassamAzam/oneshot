# Local automation tests — setup guide

When Oneshot **merges** a ticket, it puts **`Ready for Automation Testing`** on it
together with `Merged`. From there Oneshot finds the **modules the change
touched** and the **workstream-automation (Cypress) tests to run** for them — the
tests that reach the change plus each module's main-functionality tests — posts
that list on the ticket for QA, and once QA replies `approved`, runs exactly those
tests on your machine against the merged code and posts the **automation report**.
The ticket then moves to **`Automation Testing Done`**. That report is the last
thing Oneshot does on a ticket.

This runs **after the merge**, as its own mode in the same conductor, and it needs
no command: the conductor you already run (`npm start`) picks every labelled
ticket up on its own. The Loop pipeline (research → … → mr → merge) does not run
these tests and does not wait for them. A person can also put the label on any
other merged ticket to ask for a run.

This guide is for a desk that already runs Oneshot with **only the ERP repo and the
ERP database**. It adds two things: the automation repo and a copy of the
automation database. Your ERP repo and your ERP database (`hrdb`) are never changed
by this mode.

> The mode **runs** only on a desk that sets `ONESHOT_LOCAL_TESTS_REPO` in `.env`.
> Every other desk only puts the label on when it merges a ticket, and the desk
> that runs the mode picks the ticket up.
>
> **Switch it on for one desk per team.** The lock that stops a ticket being
> picked up twice is a file on the desk, so it does not reach other machines. Two
> desks with the mode on would both pick up the same ticket, both ask QA, and
> both run the tests once QA replies `approved`. As a backstop, a desk skips a
> ticket another desk has already posted a list for. Agree as a team which desk
> runs it.

---

## What you need

| Item | Why | How to check |
|---|---|---|
| Oneshot already working on ERP tickets | This mode runs in the same conductor process | `npm run doctor` passes today |
| Your ERP seed checkout (`ONESHOT_SEED_FROM`, usually `WORK_REPO`) with `node_modules` installed from the **base branch** (`dev`) | The ticket's app is built from it. A stale `node_modules` fails with `E_NODE_MODULES_DRIFT` (e.g. `posthog-js` missing) | `npm run preflight` → "Local tests" lists any missing package |
| The **workstream-automation** repo cloned, with `npm ci` done | The tests live there | step 2 below |
| Postgres **14 or newer** on your machine | To hold the automation baseline database | `psql --version` |
| The **automation database dump** from QA | The tests need the automation accounts and data | ask Arsal Tariq (QA) |
| The **Cypress logins file** from QA | The tests log in with ~20 automation accounts | ask Arsal Tariq (QA) |
| Node 22 | Oneshot and Cypress | `node --version` |
| ~6 GB free disk per run (a copy of the baseline, dropped after) | | `df -h` |

---

## One-time setup

### 1. Bring your ERP seed checkout's packages up to date

Oneshot builds every ticket's app from your seed checkout's `node_modules`. It must
contain every package the base branch (`dev`) needs:

```bash
cd /path/to/your/erp            # the folder ONESHOT_SEED_FROM / WORK_REPO points at
git fetch origin
git checkout dev && git pull     # or any checkout at origin/dev
npm ci
```

Normal Oneshot verification needs this too.

### 2. Clone the automation repo

```bash
cd ~/Desktop/workstream-repo     # anywhere you like
git clone git@gitlab.arbisoft.com:arbisoft/workstream-automation.git
cd workstream-automation
npm ci
npx cypress verify               # downloads/checks the Cypress 14.5.4 binary
```

Oneshot never edits this folder. Each run works in its own throwaway copy
(`state/runs/<ticket>/wsa-run`) and deletes it afterwards.

Don't add your logins to this clone's own `cypress.env.json`. Runs never read that
copy, and a `git diff` in the clone would print whatever you added. `npm run doctor`
warns if that file differs from the committed one.

### 3. Restore the automation database once, as the **baseline**

Get the dump file from QA (for example `hrdb_automation_dev_2026-09-29.dump`, about
500 MB, Postgres custom format). Restore it into a **new** database. Its name must
match `localTests.baselineDb` in `config/project.json` (currently
`hrdb_automation_baseline_20261002`):

```bash
createdb -h 127.0.0.1 -p 5432 hrdb_automation_baseline_20261002
pg_restore -h 127.0.0.1 -p 5432 -d hrdb_automation_baseline_20261002 \
  --no-owner --no-acl -j 4 /path/to/hrdb_automation_dev_2026-09-29.dump
```

- **It can live in the same Postgres as your ERP database.** It is a different
  database. Oneshot never touches `hrdb`.
- **If your Postgres listens on another port** (for example Postgres.app on `5433`),
  use that port here and set `ONESHOT_LOCAL_TESTS_PG_PORT` in step 5.
- **Never point an app or a SQL client at the baseline.** Oneshot copies it for each
  run (`oneshot_lt_<ticket>_<n>`, about 20 s for 5.4 GB) and drops the copy
  afterwards. Postgres refuses the copy while anything is connected to the baseline.
- **Your Postgres user needs the `CREATEDB` right.** A local superuser has it.

### 4. Save the Cypress logins file

Put the file you got from QA (same keys as the automation server's
`cypress.env.json`) outside every repo, readable only by you:

```bash
mkdir -p ~/.config/oneshot
cp /path/from/QA/cypress.env.json ~/.config/oneshot/cypress-env.json
chmod 600 ~/.config/oneshot/cypress-env.json
```

How the file is used:
- Only the run step reads it. Early in the run, before the database copy and the
  app build, it merges the logins over the automation repo's committed
  `cypress.env.json` and writes the result as `cypress.env.json` (mode 600) inside
  the run's throwaway copy, `state/runs/<ticket>/wsa-run`. That copy, file
  included, is deleted when the run cleans up, or by `gc` after a crash.
- If your file is readable by other users, the run still uses it, but
  `npm run doctor` warns. Keep it `chmod 600`.
- AI sessions are blocked from reading it, by the secret guard.
- Oneshot never prints or posts its contents.

### 5. Switch the mode on in Oneshot's `.env`

Only on the one desk your team runs this mode on (see the note at the top).

```bash
# --- Local automation tests ---
ONESHOT_LOCAL_TESTS_REPO=/Users/<you>/Desktop/workstream-repo/workstream-automation
ONESHOT_LOCAL_TESTS_CREDS=~/.config/oneshot/cypress-env.json

# Only if your desk differs from the team defaults in config/project.json:
# ONESHOT_LOCAL_TESTS_BASELINE_DB=hrdb_automation_baseline_20261002
# ONESHOT_LOCAL_TESTS_PG_HOST=127.0.0.1
# ONESHOT_LOCAL_TESTS_PG_PORT=5432
# ONESHOT_LOCAL_TESTS_PG_USER=
# Ports for the temporary app the tests run against (webpack is the second one):
# ONESHOT_LOCAL_TESTS_PORT=8030
# ONESHOT_LOCAL_TESTS_FE_PORT=9030
```

### 6. Check, then restart Oneshot

```bash
npm run doctor        # "Local tests" section: labels, repo, logins file, Cypress, Node, Postgres, baseline
                      # (the three labels must exist on the project: GitLab section)
npm run preflight     # baseline not busy, no leftovers, node_modules up to date
node scripts/localtests.cjs status    # should show no databases, worktrees or processes
```

Fix anything marked FAIL, then restart the conductor (`npm start`).

---

## Team settings (`config/project.json`, committed)

These are the same for everyone. Change them in a PR, not per desk.

| Setting | Meaning | Default |
|---|---|---|
| `localTests.enabled` | Team-wide switch: `true` makes every desk's merge put the trigger label on, and lets the mode run on the desk that has the clone; `false` turns both off | `true` |
| `localTests.baselineDb` | The database every run copies | `hrdb_automation_baseline_20261002` |
| `localTests.pgHost` / `pgPort` / `pgUser` | Where that Postgres listens (a desk can override in `.env`) | `127.0.0.1` / `5432` / your OS user |
| `localTests.dbPrefix` | Name prefix of the per-run copies, which cleanup is allowed to drop | `oneshot_lt_` |
| `localTests.automationRef` | Which automation code the tests come from | `origin/master` |
| `localTests.allowedPaths` | The folders a temporary test edit may touch. An edit outside them, or one that weakens a test (fewer assertions, `.skip`, `force: true`, a long wait) or reaches outside the browser (`cy.exec`, `cy.task`, `cy.writeFile`, `Cypress.env`), is called out in bold on the list comment, file by file with the reason, just before QA is asked to approve | `cypress/Pages/`, `cypress/fixtures/`, `cypress/e2e/` |
| `localTests.maxSpecs` / `maxRunMinutes` | A ceiling, not a target. The list is the tests that can see the change (up to 3 of them chosen because they go through the changed screen) plus every impacted module's main-functionality tests (its `smoke`-tagged specs, at most 5, or its first 5 cases when it tags none), and it is never padded with unrelated tests. Oneshot never writes or suggests a test: if no existing test reaches the change, the main-functionality tests are what runs. The list is never cut: if it goes over, the whole list stays and the comment says so. `maxRunMinutes` is also the time limit for each Cypress run (the ticket run, the retry, the run on the base), so a long list may not finish | `40` / `45` |
| `localTests.releaseBranchPattern` | Source branches that make an MR a release promotion, not the ticket's change, so the readiness check never tests a release merge | `^Adhoc-\d{4}-\d{2}-\d{2}$` |
| `localTests.devApproval` / `failuresBlock` | Not used any more: QA approves every run before it starts, and a finished run is marked done whether its tests passed or failed. Kept because the run script reads the block field for field | `any` / `false` |
| `labels.localTestsTrigger` | Put on the ticket by the Loop when it merges it (beside `Merged`), or by a person; starts the mode once the ticket's MR is merged | `Ready for Automation Testing` |
| `labels.localTestsRunning` | Replaces the trigger while QA's approved list runs | `Running TestCases Locally` (renamed from `TestCase Run Locally`) |
| `labels.localTestsDone` | Replaces either when the run is over, passed or failed, or when QA approves going on with no local test | `Automation Testing Done` |

---

## What happens on a ticket

```
Oneshot merges the ticket ──▶ "Merged" + "Ready for Automation Testing"  (one label edit)
   │     (or a person puts the label on any other merged ticket)
   ▼     the desk that runs this mode, on its next tick
"Ready for Automation Testing"  +  the ticket's MR is merged into dev or stage
   │     (labelled, not merged yet: Oneshot waits quietly and checks again later)
   ▼
throwaway ERP checkout at the MR's merge commit
   ▼
local-tests-scope   finds the impacted modules and picks the tests to run:
                    the ones that check the change + each module's main-functionality tests
   ▼
ONE comment on the ticket: the impacted-module report (or "nothing to run"), @QA, how to reply
   │
   ├─ added <test file>  ──▶ that file joins the list   ─┐
   ├─ disapproved: …     ──▶ the AI redoes the list      ┴─▶ a new comment, and it waits again
   ▼ approved
label "Ready for Automation Testing" ──▶ "Running TestCases Locally"
   ▼
local-tests-run     plain code: copy the DB, build the merge commit, run Cypress,
                    retry failures, re-run them on the base, clean up
   ▼
automation report ──▶ label "Running TestCases Locally" ──▶ "Automation Testing Done"
                      (passed or failed) — the last thing Oneshot does on the ticket
```

1. **How it starts.** When Oneshot merges a ticket, the same label edit that puts
   `Merged` on puts **`Ready for Automation Testing`** on too, as long as
   `localTests.enabled` is `true`. Every desk does this, so the one desk that runs
   this mode sees every merged ticket. A person can put the label on any other
   merged ticket. Then both must hold:
   - the ticket carries **`Ready for Automation Testing`**, and
   - the ticket's own merge request is **merged into `dev` or `stage`**
     (`localTests.targetBranches`). The tests run on the branch it went into: a
     hotfix merged into `stage` is tested on stage's merge commit, and a failure
     is re-run on stage just before it.
     Its own MR is one that closes the ticket, or has the ticket number in its
     branch name; a `#N` in another MR's title only mentions it. A promotion or backmerge (from `stage`, `master`,
     `main` or `dev`, a release branch like `Adhoc-2026-10-19`, or titled like `stage -> dev` or `Backmerge`) never counts,
     so a fix merged into stage and backmerged into dev later is tested once. A ticket with its own MRs
     merged into both has the latest one tested, and the tests chosen for all of them; the list names
     an MR that went into the other branch.

   If the ticket has its own MR but it is not merged yet, Oneshot posts nothing
   and checks again on later passes — even when some other MR that only
   mentions the ticket is merged. Only when no linked MR closes the ticket or
   names it in its branch does any linked MR merged into `dev` or `stage` count.

   Any assignee, on the one desk that runs this mode (see the note at the top;
   a desk also skips a ticket another desk has already posted a list for).

   The code under test is the **latest** of the ticket's own merged MRs, at its
   merge commit (or squash commit). The base it is compared with is the commit
   just before that change: the merge commit's first parent, or the MR's own
   starting point when it was merged without a merge commit. When the ticket has
   several merged MRs of its own, the tests are chosen for the changes of all of
   them, and the comment names each one.
2. **Choosing the tests.** Oneshot checks out the merge commit in a throwaway
   folder and works out which automation **modules** the change touched (from
   the folders it changed, `skills/local-tests-impact/scripts/modules-map.json`).
   For each impacted module it takes the module's **main-functionality tests**:
   the specs the automation team tagged `smoke`, lowest case number first, at most
   5 — or, for a module with no `smoke` tag, its first 5 cases. On top of those, the
   AI (`local-tests-scope`) adds every existing test that reaches what changed (a
   page object that selects a testid the change touched), and **up to 3 tests that
   go through the screen the change touched** — most fixes change logic, not
   testids, so the script lists every test that opens a changed screen and the AI
   keeps the ones whose steps use the changed part (the list a fix filters, the
   button whose handler it edits). It never adds unrelated tests to fill the time. If the change renamed something on purpose (a testid, a
   label), it updates the existing test to follow it, **for this run only**; those
   edits are attached to the comment as a patch. **It never writes or suggests a
   new test**: only tests that already exist in workstream-automation run.
3. **The comment, and the wait.** Oneshot always asks before it runs anything —
   QA approves every local run. It posts one comment, in one of two shapes:
   - **The impacted-module report:** "Impacted modules: Leaves, Payroll — Oneshot
     will run N automation tests locally once QA approves." It says what changed
     in one line, then a table by module: ✔️ a test that checks the change (a
     testid links it to the change, or it goes through the changed screen), ⭐ one
     of the module's main-functionality tests, ➕ a file QA added. Then the counts
     (tests that check the change, main-functionality tests, about how many
     minutes), the temporary changes with the patch attached, and an @mention of
     the QA reviewers (`config/reviewers.json` `qa`: Anosha, Arsal). If a
     temporary change weakens a test, reaches outside the browser or touches a
     file outside `localTests.allowedPaths`, a bold line just before the
     @mention names each such file and why: read the patch before approving.
   - **Nothing to run:** "Oneshot found no automation test to run locally for this
     ticket." This only happens when the change reaches no automation module (a
     backend-only change no screen with a module reaches, say). It says what
     changed, why, which workstream-automation commit it checked (`master`, by its
     short sha), and the same @mention.
4. **QA replies.** Only the first reply from a QA reviewer after the comment
   counts; anyone else's comments are ignored. With no reply, Oneshot keeps
   waiting (a cheap check on each pass). There are three answers:

   | Reply | What happens |
   |---|---|
   | `approved` (list has tests) | The label moves from `Ready for Automation Testing` to `Running TestCases Locally`, and **exactly** that list runs |
   | `approved` (nothing to run) | Nothing runs. The label moves to `Automation Testing Done`, and Oneshot records "no automation test exists for this change; approved by @… without local tests" |
   | `added cypress/e2e/…/my_test.ts` | Run that exact file as well. Oneshot fetches workstream-automation `master`, checks each path exists there, adds the ones that do to the list, names the ones it could not find, and posts the list again. `disapproved: added …` and a sentence such as "I have added cypress/e2e/…/my_test.ts" work the same |
   | `disapproved:` with what to change, e.g. `- also run LV_23` or `- remove LV_21` | The AI redoes the list with QA's bullets, on a fresh checkout of `master`, and posts it again. "Check again" is just such a change: the new list is chosen from `master` as it is now |

5. **The run.** Once approved, Oneshot posts "Local automation run started — N
   tests, about X min…" and:
   - copies the baseline database
   - builds the merge commit's app on `127.0.0.1:8030`
   - applies the temporary test edits to a throwaway copy of the automation repo
   - runs Cypress
   - runs any failed spec once more on the same code. A test that passes the
     second time is reported as **flaky**, not as a failure
   - runs the tests that failed twice on the base (the merge commit's first
     parent), to tell "caused by this ticket" from "already failing on dev". If
     there isn't enough time left before Oneshot's own time limit for this step,
     it skips this and says so in the report
   - cleans everything up

   One Cypress run per desk at a time. If the desk is busy (another Cypress run,
   the ports in use by another local-tests run, or something connected to the
   baseline), Oneshot doesn't record an error: it waits and tries again on a
   later pass.
6. **The automation report.** **"Local automation results"** shows pass/fail
   counts (and says so in the first line if Cypress was stopped at the time
   limit), a table with a reason for each failure and whether it fails on the
   tested branch too (dev, or stage for a fix merged there),
   the tests that passed only on a retry, videos of failed tests, tests that can't
   run locally, and any notes from the run. It ends with "Marked **Automation
   Testing Done**." and the label moves from `Running TestCases Locally` to
   `Automation Testing Done` — **whether the tests passed or failed**. A failure
   that does *not* also fail on that branch @mentions the MR's author, for their
   information. This is the last thing Oneshot does on the ticket.
7. **If the run could not happen** (a setup error: no baseline, a patch that no
   longer applies, the app would not build), Oneshot posts the error, takes
   `Running TestCases Locally` off and puts `Ready for Automation Testing` back.
   The ticket is not marked done, and it is picked up again once the desk is
   fixed.
8. **If the tests could not be chosen at all** (the AI session kept failing),
   Oneshot posts "Oneshot could not choose the local automation tests for this
   ticket" with the reason and @mentions QA. No label changes and nothing runs.
   It then waits: **any comment from a QA reviewer on the ticket** makes it try
   again.
9. **Asking for a run again.** Put `Ready for Automation Testing` back on a
   ticket that is done. That is a new request: the tests are chosen again, QA
   approves again, and Cypress runs again — even when nothing has changed.
   Earlier results are never posted again as if they were new. A follow-up fix
   that Oneshot merges puts the label back by itself.

## Trying it on a ticket without changing the ticket (dry run)

```bash
DRY_RUN=1 npm start -- --local-tests <iid> --assume-label
```

- `--local-tests <iid>` runs **one pass** for one ticket, then exits.
- `--assume-label` treats `Ready for Automation Testing` as present, so you can
  try any **merged** ticket. It is refused unless `DRY_RUN=1`. The merged check
  still applies: a ticket with no merged MR has nothing to test.
- Every GitLab write (comments, labels) is **logged instead of made**, and QA's
  approval is assumed. The scope session is real (one AI session is spent), so
  the log shows the list and the exact comments Oneshot would post.
- A dry run **starts no Cypress**: it stops before the database copy and says
  "a dry run starts no Cypress".
- To run the tests for real on your machine (database copy, app build, Cypress)
  while still writing nothing to GitLab, add `ONESHOT_LOCAL_TESTS_DRY_CYPRESS=1`:

  ```bash
  DRY_RUN=1 ONESHOT_LOCAL_TESTS_DRY_CYPRESS=1 npm start -- --local-tests <iid> --assume-label
  ```

- A dry run keeps its state apart, under `state-dry/state/` (`localtests/<iid>/`
  for the mode's journal, `runs/<iid>/` for the run's files), so it never touches
  a real run's.

### Measured

On the pilot run (2026-10-09):
- database copy 18 s
- database update to the ticket's code (migrate) 40 s
- first app build about 4–10 min
- 5 specs about 4–7 min

Since 2026-09-23 the ERP dev build writes `webpack-entrypoints.dev.json`, which has
no "done" marker, instead of the old stats file the readiness check waited for. So
the temporary app was never seen as ready and every run used up its whole app-build
time. That readiness bug is fixed by this change: Oneshot now reads the new file
together with webpack's own "Compiled" line, and still reads the old file on
older branches.

---

## Turning it off

- **One desk:** remove `ONESHOT_LOCAL_TESTS_REPO` from `.env`. That desk's merges
  still put the label on, for the desk that runs the mode.
- **Everyone:** set `localTests.enabled` to `false` in `config/project.json`. No
  merge puts the label on, and no desk runs the mode.
- **One ticket:** take `Ready for Automation Testing` off it before Oneshot
  picks it up.

---

## Troubleshooting

| Message | What it means | Fix |
|---|---|---|
| `E_NODE_MODULES_DRIFT` … `posthog-js` | Your seed checkout's `node_modules` is older than the ticket's `package.json` | Step 1 (`npm ci` on `dev` in the seed checkout) |
| `E_BASELINE_BUSY` | Something is connected to the baseline database. Oneshot waits and tries again later | Close that connection (SQL client, app). Never use the baseline directly |
| `E_NO_BASELINE` | The baseline database doesn't exist under that name | Step 3, or set `ONESHOT_LOCAL_TESTS_BASELINE_DB` |
| `E_PG` / `E_DB_COPY` | Postgres not reachable, or your user can't create databases | Check host/port in `.env`; grant `CREATEDB` |
| `E_NO_CREDS` / `E_CREDS_INVALID` | Logins file missing, or not valid JSON | Step 4. (A file that isn't `chmod 600` still works, but fix it: doctor warns about it) |
| `E_NO_NODE_MODULES` | The automation clone has no `node_modules` | `cd workstream-automation && npm ci && npx cypress verify` |
| `E_NO_CYPRESS` | The automation clone has no Cypress in `node_modules` | `cd workstream-automation && npm ci && npx cypress verify` |
| `E_PORT_BUSY` | Something uses 8030/9030. If it's another local-tests run or its app, Oneshot waits and tries again later | Otherwise stop it, or set `ONESHOT_LOCAL_TESTS_PORT` / `_FE_PORT` |
| `E_RUN_IN_PROGRESS` | A local-tests run for this ticket is still going. Oneshot waits and tries again later | Nothing, unless that process is stuck: then stop it and run `gc` (below) |
| `E_MIGRATE_FAILED` | The database copy couldn't be updated to the ticket's code | Usually a migration error in the ticket; read the run log |
| `E_APP_FAILED` | The ticket's app didn't start | See the harness logs under `state/runs/<ticket>/lt-harness/` |
| `E_STALE_RESOURCES` / leftovers after a crash | A previous run didn't finish cleaning up | `node scripts/localtests.cjs gc --dry-run`, then without `--dry-run`. **While a conductor is running**, add `--keep <ticket>,<ticket>` listing every ticket it has in flight: plain `gc` also removes the throwaway folder of a planning (scope) session that is still working, and that plan is then refused. `gc` only removes `oneshot_lt_*` copies and throwaway folders, and never those of a run that is still active |

---

## Refreshing the baseline

When QA provides a newer automation dump:

1. Restore it under a **new** name, for example `hrdb_automation_baseline_20261115`
   (step 3).
2. Update `localTests.baselineDb` in `config/project.json` in a PR, so every desk
   moves together.
3. After the change is merged, drop the old baseline on your desk:
   `dropdb hrdb_automation_baseline_20261002`.

A newer baseline means fewer migrations to apply per run and fewer data-related
failures.

---

## What this mode never does

- It never writes to your ERP database (`hrdb`) or to the baseline.
- It never drops a database whose name doesn't match `oneshot_lt_<ticket>_<n>`.
- It never changes your ERP checkout or your automation checkout. All work happens
  in throwaway worktrees under `state/runs/<ticket>/`.
- It never commits or pushes to workstream-automation. Temporary test edits are
  attached to the comment as a patch, for the automation team to adopt if they want.
- It never writes or suggests a new test: only tests that exist in
  workstream-automation run, and nothing runs that QA has not approved.
- It never runs inside the Loop pipeline, and never holds up an MR: it starts only
  after the change is merged.
- It never shows the Cypress logins to the AI, and never posts them anywhere.
- It never hands Oneshot's own GitLab, Slack or Claude tokens to Cypress, the app
  or the Postgres tools. Those get an environment with Oneshot's `.env` keys and
  anything named like a token, secret, key or password removed. If a login or one
  of those values shows up in an error, it is replaced with `***` before anything
  is posted.
- It never exposes the app beyond your machine. The app binds to `127.0.0.1`
  because the e2e delete API is switched on for the copy.

How the pieces fit inside Oneshot: [LOCAL-TESTS-INTERNALS.md](LOCAL-TESTS-INTERNALS.md).
