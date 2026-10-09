---
name: local-tests-impact
description: Pick the workstream-automation (Cypress) specs a ticket's diff reaches, count their test cases and what running them costs, make the smallest temporary spec edits an intended UI change needs in a throwaway automation worktree, and propose additions or trims for QA. Use when asked "which Cypress tests does this change hit", "how long will the automation suite take on this ticket", "scope the local test run", or when Oneshot's local-tests-scope phase (7.3) runs. Never commits, never runs Cypress, never weakens a test.
---

# Local Tests Impact

Oneshot runs the automation specs a ticket can break before its MR is opened, against the
ticket's own code. This phase decides WHICH specs and prepares them; `local-tests-run` (7.6,
plain code) runs exactly that list on a private copy of the automation database, and a dev
approves the results before `mr`. You choose and prepare. You never run anything.

Two people read what you return. A QA approver reads it only when your plan has specs to run
and you propose adding or dropping specs, or when Oneshot finds an edit that looks like a
weakened test. A dev reads the run's results later. Write the summary for both: plain words,
numbers first.

## 1. Run the analysis first, and believe it

```
node <index.cjs> \
  --erp <worktree> --base origin/<base branch> --head HEAD \
  --automation <runDir>/wsa --json
```

`<index.cjs>` is this skill's `scripts/index.cjs`, at the absolute path the prompt gives
(its "analysis script" line). Do not build the path from `$ONESHOT_HOME`: on a dry run that
directory has no `skills/`. `<runDir>/wsa` is the automation worktree the prompt names, and the
prompt names the ERP worktree and the base branch too. It is read-only on both repos and takes
about a second.

**Its numbers are authoritative.** Never recount `it(` blocks by grep, never re-derive modules
from folder names, never estimate minutes yourself. If one looks wrong, say so in `summary`
and still use it: a number a session computed by hand is a number nobody can reproduce.

What it gives you, and what each part is for:

- `areas` - every changed folder and its `kind`. `mapped` areas name cypress/e2e modules.
  `shared` (common/, utils/, apps/core, apps/users) map to no module on purpose: read the diff
  and add a module only with evidence (step 3). `uncovered` means no spec drives that folder.
- `modules`, `specs` - the candidates: every spec in a mapped module, plus every spec whose
  direct imports include a page object selecting a testid the diff touched. Each spec carries
  `its` (test cases), `ciSeconds`, `destructive` (it writes to the DB through an API helper)
  and `reasons`.
- `testids` - what the diff did to `data-testid` values: `added`, `removed`, `changed` (a key
  whose value moved), `referenced` (values on changed component lines), `unresolved` and
  `generic` (values too common to name one screen; they only match inside the area's own
  Pages folders).
- `removedTestidStillUsed` - values the diff removed or renamed that page objects still
  select. Those `specs` will fail on this branch. `renamedTo` is the new value when there is one.
- `addedTestidUnused` - new values no page object selects: a coverage gap (step 5).
- `totals` - `specs`, `its`, `ciSeconds`, `estimatedMinutes`
  (= ceil((Σ ciSeconds × 1.15 + specs × 8) / 60); an untimed spec costs the median).
- `warnings` - the map has drifted from a repo. Copy every one into `summary`.

A JSON object with a `code` instead (`E_REF_UNRESOLVED`, `E_NO_AUTOMATION`, `E_GIT`,
`E_NO_MAP`) is a named failure: put the code and message in `blocked` and stop. Do not
improvise a scope by hand.

## 2. Decide whether local tests apply

`applicable: false`, with the reason, when nothing a spec could observe changed: every area is
`ignored` or `other` (tests, CI config, docs), or the only change is a backend path no screen
reaches. Then `specs`, `edits` and `proposals` are empty and you are done.

Otherwise `applicable: true`, with the specs to run in `specs`. Oneshot adds the
`TestCase Run Locally` label only to a plan that has something to run.

**A plan with no spec in `specs` is posted as not needed, whatever `applicable` says.** Oneshot
writes it back as `applicable: false`: the ticket gets one "not needed" line, no label is added,
and nobody is asked anything. Any `proposals` it carries are shown on that line as suggestions for
the suite, not put to QA. So when no existing spec reaches the change and you cannot write one
(step 5), your `add` is a suggestion. To have QA look at a gap, write the spec and list it.

## 3. Choose the specs

**The precise set, then at most 5 module specs as a health check. Never pad the list.**
The prompt carries `maxSpecs` and `maxRunMinutes` from `config/project.json` (`localTests`);
price every list you consider with `estimate` (below), never by hand. They are a ceiling for
the precise set, not a target: nothing trims your list after you return it. A list over them
runs in full unless QA trims it (item 3), and every Cypress run is stopped at `maxRunMinutes`.

1. **The precise set is the floor.** It is every candidate `index.cjs` reached through
   something the diff changed rather than through its folder alone: each spec with a `reasons`
   entry other than `module …` (today `imports …, which selects …`: a page object selecting a
   testid the diff changed or touched; a reason `index.cjs` gives for a changed screen or API
   counts the same), plus every spec listed under `removedTestidStillUsed`. Those are the specs
   that can see this change, so the budget never removes one.
2. **Then at most 5 module specs, as a health check, not as coverage.** From the candidates
   whose only reason is `module …`, take the module's `smoke`-tagged specs first, then specs
   that open the changed screen's own page or sidebar group, up to 5 in all. Never fill the
   list toward `maxSpecs` or `maxRunMinutes` with module specs that cannot see the change: a
   dry run on ERP #8800 did exactly that, 40 unrelated specs and about 37 minutes, none of
   which opened the banner the ticket added. Count the module specs you left out in `summary`
   in one line (how many, which modules). The one exception is a diff that changes code every
   screen of a module runs through (its routing, a layout or container all its pages share, a
   module-wide API): then more of the module may go in, within the limits, and `summary` names
   the shared file that justifies it.
3. **If the precise set alone is over either limit, keep all of it and propose a trim.** Add no
   module specs, leave the whole precise set in `specs`, and add ONE `remove` proposal with
   `file` omitted and a `title` that starts `Trim to fit the limits:` and names the specs you
   would take out first, lowest likelihood of catching this change first, with the minutes that
   saves. `why` gives the precise set's size against `maxSpecs` and `maxRunMinutes`. Say in
   `summary` that the list runs in full unless QA trims it, and that Cypress is stopped at
   `maxRunMinutes`, so specs past it may not finish. Which tests to cut is QA's decision, not
   yours.

- **A spec you drop from the precise set gets a `remove` proposal.** There is no silent trim:
  the proposal is what arms QA's approval. Drop one only when you can name why it cannot
  exercise this change (a generic testid matched an unrelated screen, say). Group them (`file`
  omitted, `title` naming the module and the pattern) when a whole slice goes for one reason.
- **A spec that cannot run on a local machine goes in `notRunnable`, not `specs`.** Some specs
  need something a desk does not have: Odoo (the payroll sync), a real mailbox, a third-party
  service. Read the spec; when a line in it shows such a need, list it as `{ spec, why }` with
  that line in `why`, and leave it out of `specs` and out of `estimate`. It is not a drop and
  needs no proposal: the report names it, so a missing result is never read as a pass.
- **Adding a module** that `index.cjs` did not map (a shared backend change) needs file:line
  evidence: the endpoint in the diff and the screen in that module that calls it.
- `why` per spec is one plain sentence built from its `reasons`.
- `estimatedMinutes` is for YOUR final list, priced by the same code:

  ```
  node <index.cjs> estimate \
    --automation <runDir>/wsa <spec> <spec> ...
  ```

## 4. Temporary edits: follow an intended change, never excuse a broken one

A spec that fails because the ticket MEANT to rename a testid or relabel a control is not
finding a defect; it is out of date. Update it in `<runDir>/wsa` so the run tests the new
screen. A spec that fails because the change broke something is the whole point of this
phase - leave it exactly as it is.

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
  `<runDir>/artifacts/local-tests/temporary-changes.patch`, and checks it against `edits` and
  `allowedPaths`. A file outside them, or a diff that drops an assertion, is flagged to QA as a
  weakened test. Revert any experiment you do not want run.
- **Never run Cypress, start a server or touch a database.** `local-tests-run` does that, on
  a copy made for this run.

Every edited file is one `edits` entry: `kind: 'update'`, `why`, `erpEvidence`. Then re-run
step 1: it reads the throwaway as it now is, so a value you followed should be gone from
`removedTestidStillUsed`. If it is not, the edit missed.

## 5. When no spec reaches the change, write one

`addedTestidUnused`, an `uncovered` area, or a changed screen no candidate opens is a coverage
gap, and a run without a spec for it does not test this ticket at all. So **write that spec**,
and its page object, in the throwaway so the run exercises it, and also propose it for the
suite: an `add` with a `title` QA would recognise ("Verify that the evidence notice banner can
be dismissed for a week") and a `why` that names the gap. QA approves it before anything runs.
It is temporary like any other edit (`kind: 'add'`) and goes in `specs` with its module. Keep
turns for it: finish choosing by about half your turn budget. Follow the repo's own
conventions, copied from the specs beside it:

- A page object extends `PageElementReadiness`, returns its root from `pageElement`, and
  selects through `getElement({ selector: '[data-testid="<literal value>"] ' })` - a literal
  value, never one built from a variable, so `index.cjs` can see it.
- **The no-weakening rules of step 4 apply to new code too.** No `click({ force: true })`, no
  `cy.wait`, no raised timeout: a control that only works forced is covered or hidden, which
  is a finding, not something to click past. The ERP #8800 dry run wrote a forced dismiss
  click, and the check flagged it to QA.
- The spec is wrapped in `TestFilters(['regression'], () => { describe(...) })` from
  `support/filter_tests`, logs in with `loginWith('<KEY>_CREDENTIALS')` in `before`, and
  reaches the screen through `SidePanel` the way its neighbours do.
- `<KEY>` is an account that specs in the same module already log in as. Never invent one.
- Name it like its neighbours, with a `LOCAL` marker in place of the case number
  (`TR_LOCAL_evidence_notice_dismiss.ts`), so nobody mistakes it for a suite file.

Write a spec only when the screen is reachable with data the module's specs already create.
Otherwise propose the `add` and leave the file out: a spec that cannot get to its screen fails
for the wrong reason, and the dev reading the results cannot tell that from a regression.

An `add` you did not write still reaches QA when the plan has other specs to run. When it is
the whole plan - nothing in `specs` - the plan is posted as not needed (step 2) and the `add`
is a suggestion on that line that nobody is asked to approve. Say so in `summary`.

## 6. What you return

Your structured output is the `LocalTestsScope` object, written as `local-tests-scope.json`:

```
{ applicable, reason, modules, specs, edits, proposals, notRunnable, estimatedMinutes, summary, blocked? }
```

- `reason`: one sentence on why local tests do or do not apply.
- `modules`: the cypress/e2e folders your final `specs` come from.
- `specs`: `{ file, module, cases, ciSeconds, why }` per spec to run. `file` is the path from
  the automation root (`cypress/e2e/...`), `cases` is `index.cjs`'s `its`, `ciSeconds` its
  timing (omit for a new spec).
- `edits`: `{ file, kind: 'update' | 'add', why, erpEvidence }` per file you changed or created.
- `proposals`: `{ action: 'add' | 'remove', title, file?, why }`. Empty unless you added or
  dropped something - and empty means QA is not asked. QA is asked only when `specs` also has
  something to run; otherwise they are suggestions on the "not needed" line (step 2).
- `notRunnable`: `{ spec, why }` per spec kept out of `specs` because it needs what a local
  machine does not have (step 3). Empty when there is none.
- `estimatedMinutes`: from `estimate` over your final `specs`.
- `summary`: for QA and the dev, in this order: how many specs and cases run and the minutes;
  what you dropped and why, and what cannot run locally; what you added; the specs
  `removedTestidStillUsed` says will fail and whether you updated them; every `warning`.
- `blocked`: only for a named failure from step 1, or a missing `<runDir>/wsa`.

## Do not

- Do not fix the ERP code. A spec this branch breaks is a finding for the dev, not a reason to
  edit the worktree.
- Do not edit a spec to agree with a change the ticket did not ask for.
- Do not post anything. Oneshot posts the scope, the proposals and later the results.
