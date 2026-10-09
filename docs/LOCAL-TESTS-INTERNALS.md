# Local tests: `scripts/localtests.cjs` internals

The plain-code half of the local automation tests step. The conductor calls it; no session may
(`git-guard` refuses it). Setting a desk up is in [LOCAL-TESTS.md](LOCAL-TESTS.md); this page is
what each subcommand does and what it names things.

**Contract.** stdout is exactly one JSON object; logs go to stderr. A non-zero exit means stdout
is `{code, message, hint}` with a named code (`E_CONFIG`, `E_PORT_BUSY`, `E_PORT_FOREIGN`,
`E_RUN_IN_PROGRESS`, `E_BASELINE_BUSY`, `E_NODE_MODULES_DRIFT`, `E_DB_GUARD`, `E_MIGRATE_FAILED`,
`E_APP_FAILED`, `E_PATCH_MISMATCH`, `E_DEADLINE`, `E_ABORTED`, …). Failing tests are a result, not
an error: `run` exits 0 with `status: 'failed'`.

Three codes mean "try again later", and the conductor parks on them instead of recording an
error: `E_PORT_BUSY` (a port is held by another local-tests run or a harness — anything else on the
port is `E_PORT_FOREIGN`, which needs a person), `E_RUN_IN_PROGRESS` (this ticket's previous run
is still alive) and `E_BASELINE_BUSY` (something is connected to the baseline). `E_DEADLINE` from
the script means it stopped short of the conductor's `--until` so that its cleanup could still run.

**Config.** Read like `hooks/_common.cjs` and `scripts/app.cjs` read it: the Oneshot `.env` and
`config/project.json`, with the process environment winning. The `localTests` block is validated by
`settingsFrom()`, a mirror of `localTestsConfig()` that the test suite holds to it. Ports:
`ONESHOT_LOCAL_TESTS_PORT` (Django, default 8030) and `ONESHOT_LOCAL_TESTS_FE_PORT` (webpack,
default 9030). The ERP clone and seed resolve through `repourl.cjs` (`WORK_REPO`,
`ONESHOT_SEED_FROM`), as in `app.cjs`. State lives under `ONESHOT_HOME` (else `state-dry/` under
`DRY_RUN`, else this checkout).

**Secrets.** The conductor has loaded the `.env` into its own environment and passes it on, so the
script never hands `process.env` to a child as it is. Cypress, the harness (and the Django and
webpack it starts), the database guard, `migrate`, `psql` and `createdb` get `childEnv()`: the
environment without every key the Oneshot `.env` sets and without every name matching
`TOKEN|SECRET|_KEY|PASSWORD|PAT` (`PAT` as a whole word, so `PATH` stays). The clients that must
reach the copy keep libpq's `PG*` variables; Cypress does not. Before anything is printed — the
`LocalTestsRun`, an error, the `E_ABORTED` line, a log line, the harness output it echoes — every
string value of the credentials file and every value of a secret-named variable (and of
`ONESHOT_TEST_LOGIN`) is replaced by `***`, wherever it sits: a test's `error`, `reason`, `notes`,
a hint.

## Subcommands

| Command | Does | Prints |
|---|---|---|
| `prepare-scope --iid N [--automation-ref R]` | `git fetch --quiet origin` in the automation clone (a failure is logged, not fatal), then a detached worktree at `automationRef` with hooks off (`HUSKY=0`, `core.hooksPath=/dev/null`) and `node_modules` linked to the clone's. A leftover worktree of ours at that path is removed first. | `{wsa, automationSha}` |
| `capture --iid N` | In `wsa`: `git add -N .`, `git diff HEAD --binary` without `cypress.env.json` and `node_modules`, `git reset -q`. Saves the diff as the patch with its sha256 (no file and `patchSha: null` when empty — an older patch is deleted), records `{patchFile, patchSha, automationSha}` in `local-tests-capture.json`, then removes `wsa`. | `{patchFile, patchSha, automationSha, changedFiles, outsideAllowed, weakened, weakenedDetail, addedSpecs, removedSpecs}` |
| `run --iid N --worktree W --ref SHA --specs-file F [--patch P] [--patch-sha S] [--automation-sha S] [--base REF] [--deadline-min M] [--until EPOCH_MS]` | The run, below. | `LocalTestsRun` (+ `notes`) |
| `gc [--keep N,N] [--dry-run]` | For every ticket not kept: stops its harness servers and Cypress groups, drops its copies, removes its four worktrees, deletes its resources file once all of that succeeded. A ticket whose resources file names a live `localtests` process is always skipped. A copy that anything is still connected to is skipped too (it may be another Oneshot home's live run), and the drop is a plain `DROP DATABASE`, never `WITH (FORCE)`. `--dry-run` only lists. | `{dryRun, dropped, removed, killed, skipped, errors}` |
| `status` | What is held now. | `{dbs, worktrees, processes, runs, errors}` |

`--keep` must list every ticket a conductor has in flight: a scope session working in `wsa` has no
process that shows it is in use.

**The specs file** is what the conductor writes: `{"specs": ["cypress/e2e/…"], "notRunnable":
[{"spec", "why"}]}`. A bare list of paths (or of `{file}`) is still accepted. A `notRunnable` spec
is never run, even when `specs` names it too, and comes back unchanged in the result's
`notRunnable`.

**`outsideAllowed`** is every changed path not under `localTests.allowedPaths` (a prefix is a
directory: `cypress/e2e/` does not admit `cypress/e2e-old/`), plus `cypress.env.json` when it was
touched at all. **`weakened`** is the files where a hunk loses more `it(` / `describe(` /
`expect(` / `.should(` / `assert` than it gains, or gains `.skip(` / `.only(` / `force: true` /
`cy.wait(` / a timeout of 10 s or more — or gains `cy.exec(` / `cy.task(` / `cy.writeFile(` /
`Cypress.env(`, which reach outside the browser (a shell, a Node task, the disk, the credentials)
and which no temporary change needs. Counted per hunk and with comments stripped, so a renamed
testid on a `.should(` line is not flagged and a commented-out `it(` is.

## `run`, step by step

The order is fail-fast: everything that can refuse without the database first, so a missing spec,
a stale patch or a drifted `node_modules` costs seconds, not a database copy and a webpack build.
(On 2026-10-09 a drift error came only after the 19-second copy; it now comes before it.)

1. **Refuse early.** Step off (`E_CONFIG`), bad specs file, unresolvable refs, a bad `--until`, a
   patch whose sha256 is not what `--patch-sha` or the capture record says (`E_PATCH_MISMATCH`).
   No specs left to run (after `notRunnable`) → `status: 'skipped'`, nothing taken. A resources file
   from a live run → `E_RUN_IN_PROGRESS`; from a dead one, it is checked and cleaned up first
   (below). Either port held → `E_PORT_BUSY` / `E_PORT_FOREIGN`.
2. **Automation worktree** `wsa-run` at `--automation-sha` (else the capture record's sha, else
   `automationRef`), hooks off, `node_modules` linked to the clone's — and that `node_modules`
   checked against `package.json` at this sha, version-aware (below), else `E_NODE_MODULES_DRIFT`.
   Then the Cypress binary (`E_NO_CYPRESS`), the patch applied with `git apply` (working tree only),
   every planned spec present (`E_SPEC_MISSING`), and `cypress.env.json` rewritten as the committed
   file with the credentials file over it, mode 600. No value or key name is logged.
3. **ERP worktree** `erp-lt` at the ticket sha, cut from the ticket worktree's common git dir (else
   `WORK_REPO`), seeded like `app.cjs` — before the copy exists; it needs only the copy's name.
   The seed's `node_modules` is checked against this sha's `package.json` first:
   **version-aware drift** means every `dependencies`/`devDependencies` name installed, at a version
   the declared range admits — exact, `^`, `~`, x-ranges and `||` are read; any other range (a
   comparator, a tag, `npm:`, `file:`, git) is checked for presence only. Anything off is
   `E_NODE_MODULES_DRIFT` naming the packages and versions. Then `venv` and `staticfiles` linked,
   `node_modules` linked, `config.js` copied, `<runDir>/logs` created, and `local_settings.py` =
   the seed's with the `DATABASES` block pointed at the copy (password emptied), plus
   `DATABASE_NAME = '<copy>'` (settings.py keys the memcached `KEY_PREFIX` by it),
   `CELERY_BROKER_URL = 'redis://127.0.0.1:6379/15'` (a Redis DB no worker reads — the seed's broker
   is the dev app's queue, and a dev worker would run the copy's tasks against the dev database),
   `EXPOSE_E2E_API = True` and `EXPIRE_TOKEN = False`. A seed already on Redis DB 15 is refused.
4. **Database copy.** Baseline must exist (`E_NO_BASELINE`) and have zero sessions
   (`E_BASELINE_BUSY`). Name recorded, then `createdb -T <baseline> <copy>` with
   `PGAPPNAME=<copy>`, so an interrupted copy can still be found on the server and ended before the
   drop.
5. **Database guard.** The worktree's Django prints its `DATABASES['default']`,
   `CELERY_BROKER_URL` and `CACHES['default']['KEY_PREFIX']`; anything but the copy's name, the
   run's own broker and the copy's name is `E_DB_GUARD`. It runs after the copy, before `migrate`:
   `django.setup()` imports every app's signals, and nothing promises none of them queries.
6. **Migrate** the copy (`runpy manage.py migrate`, `import ssl, hashlib` first).
7. **App.** `harness.cjs up` with `ONESHOT_RUN_DIR=<runDir>/lt-harness` on the two ports. The
   harness gives webpack 20 min; if it gives up (`E_WEBPACK_DEAD`) while webpack is still alive,
   this watches the build itself until 25 min in all and then asks the harness again, which reuses
   the servers. Since ERP `d0fa609b4e` (2026-09-23) the dev build writes
   `static/webpack-entrypoints.dev.json` (`{hash, entrypoints}`, no `status`, written after a failed
   build too), so ready means that file written since the app started **and** the harness's
   `webpack.log` having "Compiled …" as its last compile line, not "Failed to compile". A branch
   from before the switch still writes `webpack-stats.dev.json`, read by its own `status`.
8. **Cypress.** `npx --no-install cypress run --spec <list> --env SERVER=<baseUrl> --browser
   electron` in its own process group, killed at the deadline (`--deadline-min`, default
   `maxRunMinutes + 10`). `--spec` is read as globs, and 21 of the automation repo's specs have
   `(s)` or `(team lead)` in their names, so each path is escaped the way fast-glob escapes a
   literal; results and videos keep the real path. Rows come from `cypress/results/.jsons/*.json`
   (mochawesome); a planned spec with no rows is `skipped` "not finished" after a deadline and
   `failed` otherwise.
9. **Retry before blame** (any failures, no deadline hit, ≤ 10 failed specs, time left): the failed
   specs run once more on the same app. A test that passes there is `flaky: true` and `passed` — its
   first error goes into a note, not the row — and is not a failure; only what fails twice goes on.
   Videos of the specs still failing are copied to `artifacts/local-tests/videos/` from this last
   run, when ≤ 25 MB (a bigger one is a note).
10. **Base re-run** (only with `--base`, failures left, ≤ 10 failed specs, and time for it): the
    base on its **own fresh copy** — recorded as `baseDb`, `createdb -T <baseline>`, the same
    seeding and guard, migrated at the base sha — never the ticket's copy, which the ticket's
    Cypress run has written to and the ticket's migrations have changed (a column the ticket added
    as NOT NULL fails every base INSERT, which would read as "fails on dev too"). The ticket app is
    stopped, the base app started on the same ports, only the failed specs run. `failingOnDev` is
    true when the test fails there too, false when it passes, null when that could not be settled;
    anything that stops the base re-run is a note, never an error, and leaves it null.
11. **Cleanup, always** — `finally`, and the SIGTERM/SIGINT/SIGHUP handler (which prints
    `E_ABORTED` and exits 128+n): stop Cypress, stop both apps, kill anything left on our ports
    from inside our checkouts, end a `createdb` still running for either copy, `DROP DATABASE …
    WITH (FORCE)` both copies, remove the worktrees, prune, then delete the resources file — only
    if every step succeeded, so `gc` can finish the job (and a note says cleanup was incomplete).

**`--until`** is the conductor's own absolute deadline (epoch ms). Without it every budget is as
above. With it, each step is cut so that 5 minutes are still left for cleanup when it ends: the app
budget, `migrate`, every Cypress run (with a note when Cypress gets less than `--deadline-min`). A
step with too little left does not start (`E_DEADLINE`; for the retry and the base re-run, a note).
The base re-run starts only with about 42 minutes left — a fresh copy and migrate, a full app
budget, a short Cypress run and cleanup — because overrunning the conductor's kill throws away the
ticket's finished results with everything else.

**`notes`** say what the result alone cannot: a run over `maxSpecs`, a Cypress run cut to fit
`--until`, flaky tests, a failure not retried or not re-run on the base (and why), a video too big
to keep, an incomplete cleanup.

**A stale resources file** (a crashed run's, or one that is not this script's at all) is cut down
before anything acts on it: a worktree must be one of the four names under this ticket's run dir, a
harness dir one of the two, a port one of the desk's pair, a database a copy of this ticket, a git
dir one of the two clones (else it is worked out from the worktree). The rest is ignored, with a
log line. A Cypress pid from it is signalled only if `ps` still shows a Cypress there — after a
reboot the number may be anybody's.

## Resource naming

Everything is under `state/runs/<iid>/` or named from it, so cleanup can find it without asking
anyone.

| What | Name | Removed by |
|---|---|---|
| Database copies | `<dbPrefix><iid>_<n>` (`oneshot_lt_8800_1`; the base re-run's is the next `n`); `n` is one past the highest on the server or in `local-tests-seq` | run cleanup, `gc` |
| Scope worktree | `wsa` | `capture`, `gc` |
| Run automation worktree | `wsa-run` (holds the mode-600 `cypress.env.json`, deleted first) | run cleanup, `gc` |
| Ticket / base ERP worktrees | `erp-lt`, `erp-base-lt` | run cleanup, `gc` |
| Harness dirs | `lt-harness`, `lt-harness-base` (`harness/servers.json`, `django.log`, `webpack.log`, plus `migrate.log`, `cypress.log`, and `cypress-retry.log` in `lt-harness`) | kept as logs |
| Resource record | `local-tests-resources.json` — `{pid, db, baseDb, worktrees[{path, gitDir}], harnessDirs, cypressPgids, ports}`, each entry written before the thing exists | last step of cleanup |
| Capture record | `local-tests-capture.json` | overwritten by the next capture |
| Patch | `artifacts/local-tests/temporary-changes.patch` | overwritten / deleted by the next capture |
| Videos | `artifacts/local-tests/videos/<path under cypress/e2e>.mp4` | the next run |
| Celery broker | Redis DB 15 on 127.0.0.1:6379 (what the copy-app enqueues stays there; nothing reads it) | not flushed: another tool on the desk may use DB 15 |

**Never touched:** the baseline, any database not matching `^<dbPrefix>\d+_\d+$` (re-checked
before every CREATE and DROP), any path other than the four worktree names above (re-checked before
every removal; neither `git worktree remove` nor the fallback follows the seed symlinks), the
developer's ERP checkout and automation clone working trees, ports outside the configured pair,
and any process whose cwd is not inside this run's checkouts (a stale file's Cypress pid: any
process that is not Cypress).

`ONESHOT_LOCAL_TESTS_HARNESS` replaces `harness.cjs` as a command; it exists only so
`src/lib/localtests-cli.test.ts` can drive `run` end to end with fakes.
