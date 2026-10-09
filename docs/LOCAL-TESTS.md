# Local automation tests — setup guide

After a ticket passes UI verification and its screenshots are posted, Oneshot can
run the **workstream-automation (Cypress) tests that the ticket affects**, on your
machine, against the ticket's own code, and post the results on the ticket.
The ticket gets the label **`TestCase Run Locally`**.

This guide is for a desk that already runs Oneshot with **only the ERP repo and the
ERP database**. It adds two things: the automation repo and a copy of the
automation database. Your ERP repo and your ERP database (`hrdb`) are never changed
by this step.

> The step is **off** on a desk until `ONESHOT_LOCAL_TESTS_REPO` is set in `.env`.
> A desk without it behaves exactly as before.

---

## What you need

| Item | Why | How to check |
|---|---|---|
| Oneshot already working on ERP tickets | This step runs inside the normal pipeline | `npm run doctor` passes today |
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

### 5. Switch the step on in Oneshot's `.env`

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
npm run doctor        # "Local tests" section: repo, logins file, Cypress, Node, Postgres, baseline, label
npm run preflight     # baseline not busy, no leftovers, node_modules up to date
node scripts/localtests.cjs status    # should show no databases, worktrees or processes
```

Fix anything marked FAIL, then restart the conductor (`npm start`).

---

## Team settings (`config/project.json`, committed)

These are the same for everyone. Change them in a PR, not per desk.

| Setting | Meaning | Default |
|---|---|---|
| `localTests.enabled` | Team-wide off switch | `true` |
| `localTests.baselineDb` | The database every run copies | `hrdb_automation_baseline_20261002` |
| `localTests.pgHost` / `pgPort` / `pgUser` | Where that Postgres listens (a desk can override in `.env`) | `127.0.0.1` / `5432` / your OS user |
| `localTests.dbPrefix` | Name prefix of the per-run copies, which cleanup is allowed to drop | `oneshot_lt_` |
| `localTests.automationRef` | Which automation code the tests come from | `origin/master` |
| `localTests.allowedPaths` | The only folders a temporary test edit may touch | `cypress/Pages/`, `cypress/fixtures/`, `cypress/e2e/` |
| `localTests.maxSpecs` / `maxRunMinutes` | A ceiling, not a target. The AI runs the tests that can see the change plus at most 5 smoke tests from the module, and never pads the list with unrelated tests. If no existing test reaches the change, it writes a temporary one, and QA approves it. Tests that can see the change are never cut: if they alone go over, the whole list stays and QA gets a "Trim to fit the limits" proposal. If QA approves, the list runs in full. `maxRunMinutes` is also the time limit for each Cypress run (the ticket run, the retry, the run on dev), so a long list may not finish | `40` / `45` |
| `localTests.devApproval` | Developer sign-off: `any` = one of the four is enough | `any` (`all` is not built yet) |
| `localTests.failuresBlock` | `false` = failures are reported, developers decide; `true` = a test that fails twice stops the run. A run cut off at the time limit with no failed test is reported, not stopped | `false` |
| `labels.localTests` | Label added to the ticket | `TestCase Run Locally` |

---

## What happens on a ticket

```
verify → screenshots → local-tests-scope (AI picks tests, temporary edits)
       → [QA approval, only if tests are added/removed or an edit looks weakened]
       → local-tests-run (plain code: copy DB, build ticket app, run Cypress, report, clean up)
       → [developer approval] → MR step
```

1. **Label and plan.** Oneshot adds `TestCase Run Locally` and posts
   **"Local automation tests — plan"**. The plan lists the affected modules, the
   spec files and number of tests, the estimated minutes, any proposed change
   to the list, and any test that reaches the change but can't run on a local
   machine (for example one that needs Odoo for payroll, or a real mailbox), with
   why.
2. **QA approval, only when needed.** If the plan adds or removes a test, or a
   temporary edit looks like it weakens a test, QA (Arsal Tariq or Anosha) replies
   `approved`, or `disapproved:` with one bullet per change.
3. **Start message.** "Local automation run started — N tests, about X min…"
4. **The run.** Oneshot:
   - copies the baseline database
   - builds the ticket's app on `127.0.0.1:8030`
   - applies the temporary test edits to a throwaway copy of the automation repo
   - runs Cypress
   - runs any failed spec once more on the ticket's code. A test that passes the
     second time is reported as **flaky**, not as a failure
   - runs the tests that failed twice on the base code, to tell "caused by this
     ticket" from "already failing on dev". If there isn't enough time left
     before Oneshot's own time limit for this step, it skips this and says so in
     the report
   - cleans everything up
5. **Report.** **"Local automation results"** shows pass/fail counts (and says so
   in the first line if Cypress was stopped at the time limit), a table with a
   reason for each failure, the tests that passed only on a retry, videos of
   failed tests, tests that can't run locally, temporary/new tests used, and any
   notes from the run (for example why "failing on dev too?" says unknown).
6. **Developer approval.** Hassam, Hira, Usman or Haider replies `approved`, and the
   MR step continues. Any other reply stops the run with `Needs Human` for a person
   to decide.

If the ticket doesn't affect any automation test, Oneshot posts one line,
"Local automation tests: not needed for this ticket — <reason>", and moves on.
The same happens when the plan has no test to run, even if the AI suggested a new
one: no label, nobody is asked, and the suggestion is shown on that line for the
automation team.

If the desk is busy when the run's turn comes (another Cypress run, the ports in
use by another local-tests run, or something connected to the baseline), Oneshot
doesn't record an error. It waits and tries again on a later pass.

### Measured

On ERP #8800 (2026-10-09):
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

- **One desk:** remove `ONESHOT_LOCAL_TESTS_REPO` from `.env`, or set
  `ONESHOT_SKIP_PHASES=local-tests-scope,local-tests-run`.
- **Everyone:** set `localTests.enabled` to `false` in `config/project.json`.

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

## What this step never does

- It never writes to your ERP database (`hrdb`) or to the baseline.
- It never drops a database whose name doesn't match `oneshot_lt_<ticket>_<n>`.
- It never changes your ERP checkout or your automation checkout. All work happens
  in throwaway worktrees under `state/runs/<ticket>/`.
- It never commits or pushes to workstream-automation. Temporary test edits are
  attached to the report as a patch, for the automation team to adopt if they want.
- It never shows the Cypress logins to the AI, and never posts them anywhere.
- It never hands Oneshot's own GitLab, Slack or Claude tokens to Cypress, the app
  or the Postgres tools. Those get an environment with Oneshot's `.env` keys and
  anything named like a token, secret, key or password removed. If a login or one
  of those values shows up in an error, it is replaced with `***` before anything
  is posted.
- It never exposes the app beyond your machine. The app binds to `127.0.0.1`
  because the e2e delete API is switched on for the copy.

How the pieces fit inside Oneshot: [LOCAL-TESTS-INTERNALS.md](LOCAL-TESTS-INTERNALS.md).
