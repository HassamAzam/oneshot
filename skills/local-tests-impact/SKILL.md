---
name: local-tests-impact
description: Pick the workstream-automation (Cypress) specs to run for a merged ticket - the ones its change reaches, up to 3 that go through the screen it changed, and the main-functionality (smoke) specs of every module it touched - count their test cases and what running them costs, and make the smallest temporary edits to existing specs an intended UI change needs, in a throwaway automation worktree. Use when asked "which Cypress tests does this change hit", "which modules does this ticket impact", "how long will the automation suite take on this ticket", "scope the local test run", or when Oneshot's local automation tests mode runs its local-tests-scope session. Never commits, never runs Cypress, never weakens a test, never writes or suggests a new test.
---

# Local Tests Impact

Oneshot runs the automation specs a ticket's change can break AFTER that change is merged. When
the Loop merges a ticket it puts `Ready for Automation Testing` on it beside `Merged` (a person can
put it on any other merged ticket); once one of its merge requests is merged into dev or stage,
Oneshot checks out that MR's merge commit and runs this session to decide WHICH specs and prepare
them. The list goes on the ticket as the impacted-module report, a QA reviewer approves it, and only
then does `local-tests-run` (plain code) run exactly that list on a private copy of the automation
database and post the automation report. You choose and prepare. You never run anything, and you
never write or suggest a new test: only tests that exist in workstream-automation run.

Two people read what you return. A QA reviewer reads your list on the ticket every time - QA
approves every local run - and can approve it, change it, or add a test file they have. A dev
reads the results later. Write the summary for both: plain words, numbers first.

## 1. Run the analysis first, and believe it

```
node <index.cjs> \
  --erp <worktree> --base <first parent> --head <merge commit> \
  --automation <runDir>/wsa --json
```

`<index.cjs>` is this skill's `scripts/index.cjs`, at the absolute path the prompt gives
(its "analysis script" line). Do not build the path from `$ONESHOT_HOME`: on a dry run that
directory has no `skills/`. `<merge commit>` is the merge commit of the ticket's MR, which the ERP
worktree is checked out at; `<first parent>` is that commit's first parent, the base branch exactly
as it was before the change landed. The prompt names both, the ERP worktree and `<runDir>/wsa`, the
automation worktree. It is read-only on both repos and takes about a second.

**Its numbers are authoritative.** Never recount `it(` blocks by grep, never re-derive modules
from folder names, never estimate minutes yourself. If one looks wrong, say so in `summary`
and still use it: a number a session computed by hand is a number nobody can reproduce.

What it gives you, and what each part is for:

- `areas` - every changed folder and its `kind`. `mapped` areas name cypress/e2e modules.
  `shared` (common/, utils/, apps/core, apps/users) map to no module on purpose: read the diff
  and add a module only with evidence (step 3). `uncovered` means no spec drives that folder.
- `modules`, `specs` - the candidates: every spec in a mapped module, plus every spec whose
  direct imports include a page object selecting a testid the diff touched. Each spec carries
  `its` (test cases), `ciSeconds`, `destructive` (it writes to the DB through an API helper),
  `smoke` (tagged `smoke` in its `TestFilters([...])`), `main` (one of `mainSpecs`) and
  `reasons`.
- `mainSpecs` - the main-functionality specs of every module in `modules`: each module's own
  `smoke`-tagged specs, lowest case number first, at most 5; a module that tags none gives its
  first 5 cases (`basis: 'first'`). These run for every impacted module (step 3). Picked by the
  script so one module always gives the same tests: never pick them yourself.
- `screenSpecs` - candidates that open a screen the change touched: specs whose direct page
  objects (`via`) select a testid that a changed component (`screens`) renders anywhere in the
  file, not only on its changed lines. `matched` counts those testids; impacted modules come
  first; at most 25 are listed (`screenSpecsTotal` says how many there were). They are
  candidates, not answers: step 3 item 2 says how to choose.
- `testids` - what the diff did to `data-testid` values: `added`, `removed`, `changed` (a key
  whose value moved), `referenced` (values on changed component lines), `unresolved` and
  `generic` (values too common to name one screen; they only match inside the area's own
  Pages folders).
- `removedTestidStillUsed` - values the diff removed or renamed that page objects still
  select. Those `specs` will fail against the merge commit. `renamedTo` is the new value when
  there is one.
- `addedTestidUnused` - new values no page object selects: a coverage gap. Say so in `summary`;
  the module's main-functionality specs are what runs for it (step 3).
- `totals` - `specs`, `its`, `ciSeconds`, `estimatedMinutes`
  (= ceil((Σ ciSeconds × 1.15 + specs × 8) / 60); an untimed spec costs the median).
- `warnings` - the map has drifted from a repo. Copy every one into `summary`.

A JSON object with a `code` instead (`E_REF_UNRESOLVED`, `E_NO_AUTOMATION`, `E_GIT`,
`E_NO_MAP`) is a named failure: put the code and message in `blocked` and stop. Do not
improvise a scope by hand.

## 2. Decide whether local tests apply

`applicable: false`, with the reason, only when no automation module is impacted and no spec
reaches the change: `modules` and `mainSpecs` are empty and every area is `ignored`, `other`,
`uncovered`, or `shared` with no testid match (tests, CI config, docs, a backend path no screen
reaches). Then `specs`, `edits` and `proposals` are empty and you are done.

Otherwise `applicable: true`, with the specs to run in `specs`.

**Whatever you return goes on the ticket for QA.** A list with specs in it is posted as the
impacted-module report: each module, and under it every test that will run, marked as a test that
checks the change or one of the module's main-functionality tests. QA approves it before anything
runs. A list with no spec in `specs` is posted as "nothing to run", with your `reason`. QA then
decide: approve (go on without local tests), add a test file they have on master (Oneshot runs that
exact file), or reply `disapproved:` with what to change (a later round, step 6).

## 3. Choose the specs

**The precise set, up to 3 specs that go through the changed screen, then every impacted
module's main-functionality specs. Never pad the list.**
The prompt carries `maxSpecs` and `maxRunMinutes` from `config/project.json` (`localTests`);
price every list you consider with `estimate` (below), never by hand. They are a ceiling, not a
target: nothing trims your list after you return it. A list over them
runs in full unless QA trims it (item 4), and every Cypress run is stopped at `maxRunMinutes`.

1. **The precise set is the floor.** It is every candidate `index.cjs` reached through
   something the diff changed rather than through its folder alone: each spec with a `reasons`
   entry other than `module …` (today `imports …, which selects …`: a page object selecting a
   testid the diff changed or touched; a reason `index.cjs` gives for a changed screen or API
   counts the same), plus every spec listed under `removedTestidStillUsed`. Those are the specs
   that can see this change, so the budget never removes one.
2. **Then at most 3 specs that go through the screen the change touched, from `screenSpecs`.**
   Most fixes change logic, not testids, so the precise set is often empty while a spec does open
   the changed screen. But a popup's page object is imported by many specs (on one ticket fourteen
   opened the changed popup and two went through what the fix changed), so opening the screen is
   not enough. Work hunk by hunk: find the control or section the hunk renders or handles (the
   list it filters, the button whose handler it edits), find that element's getter in the `via`
   page object, and grep the candidates for it - a spec that calls the getter goes through the
   change; prefer one that asserts on that element. Start each one's `why` with `Opens the
   changed screen:` and cite the spec line. Take none when no candidate goes through a changed
   hunk, and say so in `summary`. A candidate you leave out needs no proposal: it was never on the
   list.
3. **Then every impacted module's main-functionality specs: `mainSpecs`, all of them, whether or
   not the precise set is empty.** Start each one's `why` with `Main functionality:` ("Main
   functionality: submits a leave request"): the ticket marks those rows by it. A spec already in
   the precise set is listed once, as a precise spec. With an empty precise set they are the whole
   list - that is the answer, not a gap to fill. Oneshot adds back any you leave out without a
   reason (a `remove` proposal naming its file, or `notRunnable`), so leaving one out by accident
   changes nothing. Never fill the list toward `maxSpecs` or `maxRunMinutes` with other module specs that
   cannot see the change: a dry run that did exactly that picked 40 unrelated specs and about 37
   minutes, none of which opened the banner the change added. Count the module specs you left out
   in `summary` in one line (how many, which modules). The one exception is a diff that changes
   code every screen of a module runs through (its routing, a layout or container all its pages
   share, a module-wide API): then more of the module may go in, within the limits, and `summary`
   names the shared file that justifies it.
4. **If the list is over either limit, keep all of it and propose a trim.** Leave the whole list
   in `specs`, and add ONE `remove` proposal with `file` omitted and a `title` that starts
   `Trim to fit the limits:` and names the specs you would take out first, lowest likelihood of
   catching this change first, with the minutes that saves. `why` gives the list's size against
   `maxSpecs` and `maxRunMinutes`. Say in `summary` that the list runs in full unless QA trims
   it, and that Cypress is stopped at `maxRunMinutes`, so specs past it may not finish. Which
   tests to cut is QA's decision, not yours.

- **A spec you drop from the precise set or from `mainSpecs` gets a `remove` proposal naming its
  file.** There is no silent trim: the proposal is what QA sees. Drop one only when you can name
  why it cannot run usefully here (a generic testid matched an unrelated screen, say). Group them
  (`file` omitted, `title` naming the module and the pattern) when a whole slice goes for one
  reason.
- **A spec that cannot run on a local machine goes in `notRunnable`, not `specs`.** Some specs
  need something a desk does not have: Odoo (the payroll sync), a real mailbox, a third-party
  service. Read the spec; when a line in it shows such a need, list it as `{ spec, why }` with
  that line in `why`, and leave it out of `specs` and out of `estimate`. It is not a drop and
  needs no proposal: the ticket names it, so a missing result is never read as a pass. A
  main-functionality spec can be one of these too.
- **Adding a module** that `index.cjs` did not map (a shared backend change) needs file:line
  evidence: the endpoint in the diff and the screen in that module that calls it.
- `why` per spec is one short line on what it checks in this change, built from its `reasons`.
  The ticket shows it clipped to about 120 characters.
- `estimatedMinutes` is for YOUR final list, priced by the same code:

  ```
  node <index.cjs> estimate \
    --automation <runDir>/wsa <spec> <spec> ...
  ```

## 4. Temporary edits: follow an intended change, never excuse a broken one

A spec that fails because the ticket MEANT to rename a testid or relabel a control is not
finding a defect; it is out of date. Update it in `<runDir>/wsa` so the run tests the new
screen. A spec that fails because the change broke something is the whole point of this
phase - leave it exactly as it is. These updates are yours to make without being asked, and they
are the only edits you make: never a new spec or page object (step 5).

Edit only when the diff proves the change is intended: the ticket asks for it, and the ERP
file:line that makes it goes in `erpEvidence`. `removedTestidStillUsed` with a `renamedTo` is
the usual case. Make the smallest edit that follows it, usually one selector string.

- **Only under `cypress/Pages/`, `cypress/fixtures/` and `cypress/e2e/`** of `<runDir>/wsa`.
  Never `cypress.config.ts`, `package.json`, `.gitlab-ci.yml`, or `cypress.env.json` - do not
  even open that last one; it holds the test accounts' credentials.
- **Never weaken a test.** No removed assertion or `it` block, no `.skip` or `.only`, no
  `force: true`, no raised timeout, no added `cy.wait`. A test made to pass by asking less of
  the app hides the regression this phase exists to catch.
- **Never commit, never push, never check out another ref** in the throwaway. Leave the edits
  in the working tree: Oneshot saves the worktree's diff, new files included, as
  `<runDir>/artifacts/local-tests/temporary-changes.patch`, attaches it to the list on the
  ticket, and checks it against `edits` and `allowedPaths`. A file outside them, or a diff that
  drops an assertion, is flagged to QA as a weakened test. Revert any experiment you do not want
  run.
- **Never run Cypress, start a server or touch a database.** `local-tests-run` does that, on
  a copy made for this run.

Every edited file is one `edits` entry: `kind: 'update'`, `why`, `erpEvidence`. Then re-run
step 1: it reads the throwaway as it now is, so a value you followed should be gone from
`removedTestidStillUsed`. If it is not, the edit missed.

## 5. When no spec reaches the change, run the module's main functionality - never write a test

`addedTestidUnused`, an `uncovered` area, or a changed screen no `screenSpecs` candidate goes
through is a coverage gap: no existing spec tests this exact change. **Do not write a spec for it, and do not propose
one.** The impacted modules' main-functionality specs (step 3) are what runs. Say in `summary`, in
one line, what no spec reaches, so QA know; if they have a test for it, they add it to
workstream-automation themselves and reply `added <file>`, and Oneshot runs that file too.

A new spec file in your worktree is refused when you finish: Oneshot sees it in the saved diff,
throws the whole list away and runs the scope again. Only tests that exist in workstream-automation
run.

## 6. A round after QA's reply

QA have three answers. Two need no session: `approved` runs the list, and `added <file>` (or
`disapproved: added <file>`) looks that exact file up on master and puts it on the list. You are
run again for the third:

- **`disapproved:` with what to change** - QA's own words, which the prompt quotes. Apply all of
  it and return the WHOLE list again; it goes back to them for approval. A spec they ask to add
  goes in `specs` even when the analysis did not reach it, with a `why` saying QA asked; they may
  name it by file, by a case id (`LV_23`) or by a module whose main-functionality tests they want:
  find the file in the automation worktree whose name or `it` titles carry it, and name one you
  cannot find in `summary` rather than guess. A spec they ask to remove leaves `specs` with no
  `remove` proposal - the decision is already theirs, for a main-functionality spec too. A test
  that does not exist yet is not yours to write: say in `summary` that QA can add it and reply
  `added <file>`. "Check again" means take master as it is now: your worktree is a fresh checkout
  of it, so run step 1 again. Open `summary` with what changed from the previous list, in one
  line. The previous round's temporary edits survive only as the patch; the prompt says how to
  apply it to your fresh worktree.

## 7. What you return

Your structured output is the `LocalTestsScope` object, written as `local-tests-scope.json`:

```
{ applicable, reason, modules, specs, edits, proposals, notRunnable, estimatedMinutes, summary, blocked? }
```

- `reason`: one sentence on why local tests do or do not apply.
- `modules`: the impacted cypress/e2e folders your final `specs` come from.
- `specs`: `{ file, module, cases, ciSeconds, why }` per spec to run. `file` is the path from
  the automation root (`cypress/e2e/...`), `cases` is `index.cjs`'s `its`, `ciSeconds` its
  timing, `why` one short line (`Opens the changed screen: …` for an item-2 pick, `Main
  functionality: …` for a main-functionality spec).
- `edits`: `{ file, kind: 'update', why, erpEvidence }` per existing file you changed.
- `proposals`: `{ action: 'remove', title, file?, why }` for a spec you dropped or a trim.
  Usually empty. Never an `add`.
- `notRunnable`: `{ spec, why }` per spec kept out of `specs` because it needs what a local
  machine does not have (step 3). Empty when there is none.
- `estimatedMinutes`: from `estimate` over your final `specs`.
- `summary`: for QA and the dev, in this order: how many specs and cases run per module and the
  minutes; which changed-screen candidates you took and the getter that decided it, or that none
  goes through a changed hunk; what you dropped and why, and what cannot run locally; what no
  spec reaches; the specs `removedTestidStillUsed` says will fail and whether you updated them;
  every `warning`.
- `blocked`: only for a named failure from step 1, or a missing `<runDir>/wsa`.

## Do not

- Do not fix the ERP code. A spec this change breaks is a finding for the dev, not a reason to
  edit the worktree.
- Do not edit a spec to agree with a change the ticket did not ask for.
- Do not write a new spec or suggest one (step 5).
- Do not post anything. Oneshot posts the impacted-module report and later the automation report.
