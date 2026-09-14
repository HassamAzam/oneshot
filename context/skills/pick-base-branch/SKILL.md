---
name: pick-base-branch
description: Determine the correct base/target branch for a fix or feature in this ERP repo by finding where the issue was discovered. Trigger whenever the user is about to branch for a bug fix or feature and the base is not obvious; when they ask "which branch should I branch from", "where does this fix go", "is this a dev/stage/prod issue"; or before any fix branch is created from a GitLab issue or bug report. Implements the model in .claude/rules/branching.md. Bugs are tracked as GitLab issues; relies only on the git repo + GitLab issues (no Jenkins, no per-developer setup).
version: 1.0.0
---

# Pick Base Branch

Decides **base == target == the environment branch where the issue was discovered**, then prints
the branch-creation commands. New feature work with no pre-existing bug defaults to `dev`.

Read `.claude/rules/branching.md` for the full model. This skill is the executable procedure.

## Environment ↔ branch map

| Branch   | Env | Host |
|----------|-----|------|
| `dev`    | dev / QA   | `dev-workstream.arbisoft.com` |
| `stage`  | staging / UAT | `workstream-staging.arbisoft.com` |
| `master` | production | `erp.arbisoft.com`, `workstream.arbisoft.com` |
| `<user>/<topic>` | in-flight feature preview | per-branch |

Promotion `dev→stage→master`; back-merges `master→stage→dev` carry a fix downstream — so a fix
lands at the discovery env and flows *down*, never via re-promotion from `dev`.

## Procedure

### Step 1 — E: discovery environment (from the GitLab issue)

If given a GitLab issue, read its labels and description (GitLab MCP `get_issue`, or ask the user
to paste it). Resolve E in this priority order, stop at the first hit:

1. Label `prod-sentry` or any Sentry origin → **prod**.
2. Env label: `prod`/`production` → **prod**; `staging`/`uat` → **stage**; `dev`/`qa` → **dev**.
3. URL host in the description matched against the map above → that env.
4. Reporter (tiebreak): end-user / people-partner / CEO → prod; QA → dev or stage; a dev on their
   own branch → feature preview.

If none match → **E = unknown** (resolved in Step 3).

### Step 2 — C: containment frontier (deterministic, always run)

Find the introducing commit (git-blame the buggy lines, or the original feature MR's merge commit),
then:

```bash
git fetch origin dev stage master
git branch -r --contains <sha> | grep -E 'origin/(dev|stage|master)$'
```

- in `master` → in prod
- in `stage` not `master` → at stage
- in `dev` not `stage` → at dev
- in none → in-flight; code exists only on a feature branch (find it with
  `git branch -r --contains <sha>`)

If the bug cannot be traced to a commit yet (brand-new behaviour), C is unavailable — rely on E.

### Step 3 — Reconcile → base branch

| Situation | Base = Target |
|---|---|
| C shows code only on a feature branch, or E = preview | that **feature branch** |
| E = prod (and code is in `master`) | **`master`** via `/create-adhoc`; then back-merge `master→stage→dev` |
| E = stage | **`stage`** |
| E = dev, or new feature work | **`dev`** |
| **E and C conflict** | **C wins** (e.g. "staging" label but code only on a feature branch → that feature branch) |
| **E unknown** | use **C's topmost** branch as the default, then **confirm with the user** |

Never branch blind. When E (label/URL/Sentry) agrees with C, proceed with no question. When E is
unknown or conflicts unresolvably, present the educated guess as the **pre-selected default** and
ask — do not ask cold.

### Step 4 — Output

Print the ready-to-run commands for the chosen base:

```bash
git fetch origin <base>
git checkout <base>
git pull --ff-only origin <base>
git checkout -b <username>/<topic-or-ticket>
```

For the prod/Adhoc path, hand off to `/create-adhoc` instead and note the required
`master→stage→dev` back-merge. State the resolved E, the C frontier, and the reason for the pick in
one line so the choice is auditable.

## Confirm-with-default template (when asking)

> This looks like a **<env>** issue — introducing commit `<sha>` is in `origin/<X>` but not
> `origin/<Y>`, and issue #<n> <label/URL evidence>. I'll branch `<username>/<topic>` from
> `origin/<base>` and target `<base>`. Override?
> Options: **<recommended> (recommended)** · <other envs> · a feature branch

## Examples

| Issue signal | C frontier | Pick | Why |
|---|---|---|---|
| `prod-sentry` label | in master | `master` / Adhoc | Sentry = prod |
| Desc URL `workstream-staging.arbisoft.com` | in stage, not master | `stage` | staging bug |
| QA report, no URL | in dev only | `dev` | dev frontier, no prod/stage signal |
| Label "staging" | code only on `maaz/odoo-18-changes` | `maaz/odoo-18-changes` | C overrides E — seen on preview deploy |
| New feature, no bug | n/a | `dev` | default for new work |
