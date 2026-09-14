# Branching & Base-Branch Selection

The base branch is **not always `dev`**. It is decided by *where the issue was discovered* —
i.e. which environment the buggy code is running in. New feature work defaults to `dev`; fixes
follow the bug. Picking the wrong base sends the fix to the wrong environment (or drags in
unrelated commits) and breaks the merge back.

## The model

```
PROMOTION (code moves up):   dev ──► stage ──► master (prod)
SYNC / BACK-MERGE (down):    master ──► stage ──► dev
```

| Branch   | Environment | URL |
|----------|-------------|-----|
| `dev`    | dev / QA integration | https://dev-workstream.arbisoft.com/ |
| `stage`  | staging / UAT        | https://workstream-staging.arbisoft.com/ |
| `master` | production           | https://erp.arbisoft.com/ (a.k.a. workstream.arbisoft.com) |
| `<user>/<topic>` | ad-hoc preview deploy of an in-flight feature | per-branch |

A fix **lands at the environment where the bug was found, and back-merges carry it downstream.**
A stage fix reaches `dev` via the `stage→dev` back-merge — you do *not* fix it in `dev` and
re-promote. This is why "always branch from `dev`" is wrong: it forces every fix through the
slowest path, and often through code that is not even in `dev` yet.

## Governing rule

> **base == target == the branch of the environment where the issue was discovered.**

You branch off that branch's tip and open the MR back into the same branch. The only variable is
*which* branch. For a brand-new feature with no pre-existing bug, the environment is "dev by
default" → base `dev`.

## How to pick the base — two inputs

### E — discovery environment (primary)

Read the **GitLab issue** (bugs are tracked as GitLab issues). In priority order:

1. **Sentry origin / `prod-sentry` label → prod.**
2. **Env label** on the issue: `prod`/`production` → prod, `staging`/`uat` → stage, `dev`/`qa` → dev.
3. **URL in the description**, matched against the host table above:
   - `dev-workstream.arbisoft.com` → dev
   - `workstream-staging.arbisoft.com` → stage
   - `erp.arbisoft.com` / `workstream.arbisoft.com` (any other known host) → prod
4. **Reporter identity** (tiebreak only): end-users / people-partners / CEO → prod; QA → dev/stage; a dev testing their own branch → feature preview.

### C — containment frontier (deterministic constraint)

Find the introducing commit, then see how far it has been promoted:

```bash
git fetch origin dev stage master
git blame -L <start>,<end> <file>        # or use the original feature MR's merge commit
git branch -r --contains <sha> | grep -E 'origin/(dev|stage|master)$'
```

- in `master` → already in prod
- in `stage` not `master` → currently at stage
- in `dev` not `stage` → currently at dev
- in **none** of them → in-flight; the code only exists on a feature branch

C is always available (everyone has the repo) and it is the **validator**: the fix's target must
contain the buggy code, or be the branch that introduces it.

## Decision table

| Discovery (E), validated by C | Branch from → MR into | How |
|---|---|---|
| In-flight feature (C = feature branch only, or E = preview deploy) | the **feature branch** | branch off `origin/<feature-branch>`, MR into it |
| **Prod** (Sentry / prod label / prod URL / prod user) | **`master`** via Adhoc | use `/create-adhoc` (branch `Adhoc-YYYY-MM-DD`, Adhoc label), then back-merge `master→stage→dev` |
| **Stage / UAT** | **`stage`** | branch off `origin/stage`; `stage→dev` back-merge follows |
| **Dev / QA**, and all *new* feature work | **`dev`** | branch off `origin/dev` (the default) |
| **Unknown** | C's topmost branch as the educated-guess default, **then confirm** | never branch blind |

When E (from a label/URL/Sentry) **agrees** with what C allows, pick the base with no question.
When E and C **conflict**, C wins — e.g. an issue labelled "staging" whose code lives only on a
feature branch was really seen on that branch's preview deploy → target the feature branch.

## Creating the branch

```bash
git fetch origin <base>                 # base = dev | stage | master | <feature-branch>
git checkout <base>
git pull --ff-only origin <base>
git checkout -b <username>/<topic-or-ticket>
```

Naming: `<username>/<topic-or-ticket>` (e.g. `ibrahim/fix-gift-carry-forward-double`).

## If you branched from the wrong place

Rebase onto the **correct target** — *not* always `dev`:

```bash
git fetch origin <correct-target> && git rebase origin/<correct-target>
```

Rebasing a stage- or master-targeted fix onto `dev` pulls in dev-only commits and breaks the
merge back into stage/master. Renumber any migrations that collide with ones merged into the
target while you were working (and update `apps/<app>/migrations/max_migration.txt`).

## Automating it

`/pick-base-branch <gitlab-issue-or-bug>` runs the E + C checks above and either picks the base
deterministically or presents the recommended default for confirmation.
