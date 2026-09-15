---
name: ship-ticket
description: Take one ticket from its URL to an open MR in a single session — bring the app up (reusing one that is already running), analyse, plan, implement, test it in a real browser, and raise the MR with evidence. Use when asked to "one-shot this ticket", "take this end to end", "set it up, fix it and raise the MR", "run the whole pipeline on this", or when handed a ticket/MR URL with no narrower instruction. Not for reviewing someone else's MR (erp-code-review).
---

# Ship a ticket

One session, six phases, one MR. The phases are ordered because each one's output is
the next one's input — but the ONLY phase with a fixed cost is the first, and it is
the one that has historically eaten the session. Do it in one command and move on.

## The prompt

```
Ship <ticket-url> end to end: app up, analyse, plan, implement, test in the browser, MR.
Ref: <branch|!MR|#PR>   (optional — omit to work on a fresh branch off dev)
Stop and ask me only if: the ticket is ambiguous about expected behaviour, a test fails
for a reason that is not this change, or the fix needs a schema migration.
```

Everything below is what that sentence means. Follow it in order.

## 0. The app must be up. One command. Never by hand.

**Inside a Oneshot run it is already coming up.** The conductor started it in the background
when the run leased its worktree, so your job is to confirm it, not to start it:

```
node $ONESHOT_HOME/scripts/app.cjs ensure          # no args: uses $ONESHOT_WORKTREE/$ONESHOT_PORT
```

That form brings the app up for *your* checkout and never moves its ref, so it is safe to run
at any point — including after `implement` has left uncommitted work in the tree. If the
conductor's bring-up is still compiling you join it; you never restart it.

**Working by hand, outside a run**, name what you want instead:

```
node scripts/app.cjs ensure --ref <branch|!MR|#PR|sha>
```

It answers, machine-wide, "is an app already running, and is it on my code?" and it
takes whichever of the three paths applies:

| what it found | what it does | measured |
|---|---|---|
| an app already on that commit | hands it to you untouched | ~3s |
| an app up on other code, in a worktree we own and that is clean | checks the ref out into it, restarts Django, waits for webpack's incremental rebuild | ~10s |
| nothing usable | seeds a worktree and cold-starts both processes | ~2min |

All three print the same `app-env.json` — `baseUrl`, `bePort`, `fePort`, `worktree`,
`bundleUrl`, `head` — so **never branch on which one happened**.

- **Do not start servers yourself, and do not `npm start`.** The app is two processes,
  you navigate to the *Django* origin, and the readiness signal is not a log line.
  `harness.cjs` holds those facts; `app.cjs` holds the reuse decision. Every session
  that improvised a bring-up spent between a third and four fifths of its budget on it.
- **Do not touch a checkout you did not create.** `ensure` refuses to, on purpose: the
  developer's own repo is usually running and usually has uncommitted work in it. If
  the only healthy app is `role: foreign`, you get a cold start, not a `git checkout`
  into their day's work.
- If it returns a named code (`E_NO_PORTS`, `E_SEED_MISSING`, `E_DJANGO_DEAD`,
  `E_WEBPACK_DEAD`, `E_MIGRATE_FAILED`, …), **report the code and its hint**. Do not
  improvise a repair. `node scripts/app.cjs gc --kill` reaps orphaned servers and is
  the fix for `E_NO_PORTS` specifically.
- Log in with `node skills/local-browser-verify/scripts/harness.cjs smoke` before you
  believe any of it. It is 12 seconds and it is the only proof the app actually renders.

Now the fixed cost is paid. Nothing after this point has a floor.

## 1. Analyse — read the ticket, then read the code it is about

Produce, in your own notes and in the MR description later:

- **What a user does, and what they see instead.** In the ticket's words, not the
  code's. If the ticket does not say, say that it does not and pick the reading you
  will build to — do not silently choose one.
- **The acceptance criteria, listed.** These, not the diff, are the source of truth for
  every test you write in phase 4.
- **The UI path**: the route, the module key (`harness.cjs modules`), the permission or
  group that gates it, and the `data-testid`s on the screen. Excavating this later, with
  a diff in view but no vocabulary, is what killed run 237 at its turn cap.
- **The blast radius**: what else reads the function or component you are about to
  change. `grep` for callers before you decide the shape of the fix.

## 2. Plan — reuse first, and keep it short

Search before you write: this repo has `common/`, `apps/*/utils.py`,
`frontend/src/common/` and `frontend/src/components/shared/` full of helpers that a new
function will duplicate. The `planning-methodology` and `util-reuse-methodology` skills
carry the search patterns.

The plan is a handful of steps naming real files and real symbols. If it needs a schema
migration, or it touches `apps/auth/`, `apps/payroll/`, `apps/leaves/`,
`common/permissions.py` or the login components, **stop and confirm before implementing**
— those are the high-scrutiny paths and the ticket most worth pausing on is the one
nobody remembered to label.

## 3. Implement — through the agents, with the standards loaded

- Django/Python: the **backend-agent**, which enforces `_base_manager` in data
  migrations, `_<ModelName>` naming under `apps.get_model()`, and flake8 + pylint after
  every `.py` change.
- React: the **frontend-agent**, with `react-frontend-standards`.
- **Review their diffs for whole-file churn.** Neither agent is declared with `Edit` —
  both are `Read, Write, Bash` — so every change they make is a full-file `Write`, and a
  file they only partly changed can come back with unrelated lines rewritten. Read the
  diff, not the summary, before moving on.
- Migrations: one per task, schema and data separated, reversible —
  `django-migration-standards` is not optional reading if you touch `migrations/`.
- After the change lands, `node scripts/app.cjs ensure --ref <your-branch>` again: it is
  a Django restart and an incremental rebuild, not a bring-up. Django runs `--noreload`,
  so **Python edits are not live until that restart**. This is the single most common
  way a session tests the code it wrote ten minutes ago.

## 4. Test — write the cases from the criteria, then execute them in the browser

Write the case list **from the acceptance criteria**, before running anything, with an
`expected` per case derived from the business rule and not from what the code now does.
Cover: the happy path, the negative, the boundary the ticket implies, and the one
side-effect the change could plausibly break.

Then execute every case against the real UI with Playwright, driven through the harness
(`open` / `login` / `goto` / `runCase`). `local-browser-verify` holds the rules that
each cost a run: wait for data and not for skeletons, read table cells by column header
and never by index, retry a flaky step twice, and never `waitForURL` after a login the
app performs with `history.push`.

Record **one result per case** — pass, fail, blocked or skipped, with actual-vs-expected
in the case's own terms. A silently dropped case is worse than a failing one. Screenshot
every failure and every high-blast pass.

Backend `pytest` is fine and worth running. **Never Jest**: that harness is rotted in
these repos, CI does not run it, and hours have already been lost trying to repair it.

If a case fails: fix it and re-run that case. If it fails for a reason that is not this
change, that is a **regression note in the MR**, not a case failure, and not yours to
fix in this branch.

## 5. Raise the MR — with the evidence a reviewer needs to not check it out

- Title and the closing-ticket link: the `mr-metadata` skill governs both. Get the
  ticket reference right; a reviewer who cannot find the ticket reads the diff blind.
- Description: what changed and why, the acceptance criteria as a checklist with met /
  unmet, how it was verified (the case list and its verdicts), and the evidence.
- Screenshots: before-and-after pairs plus the states no test reaches —
  `ui-evidence-pack` covers how to attach them so they actually render in GitLab.

## Leave the app running

Do not tear the servers down at the end. The next session's `ensure` will reuse them in
three seconds, and that is the entire point of this document. `app.cjs gc --kill` when
the machine is genuinely done, never as a courtesy.

## Do not

- Do not declare it working because the build compiled, or because a page returned 200.
  Django's catch-all answers 200 for every path from the moment it boots, bundle or no
  bundle.
- Do not `npm ci`, `npm install` or rebuild the venv in a worktree. `node_modules` and
  `venv` are symlinks into a shared repo; installing rewrites them for every other
  worktree on the machine.
- Do not commit the port patches. `frontend/config/localPaths.js` and
  `frontend/src/constants/config.js` carry machine-local ports and are held with
  `--skip-worktree`; `app.cjs` re-applies and re-marks them after every checkout.
- Do not push to `dev`, `stage`, `master` or `main`. Branch, then MR.
