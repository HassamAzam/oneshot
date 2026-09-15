---
name: mr-changelog-generator
description: This skill MUST be applied whenever a user wants to generate a changelog for an MR, document what changed between two branches, or attach a QA guide to a GitLab MR or ticket. Triggers on "changelog", "change log", "QA guide for MR", "document my MR", "what changed between branches", "add changelog to MR", or when the user provides a GitLab MR URL and wants it documented.
version: 1.0.0
---

# MR Changelog Generator

Covers three mandatory outputs for every changelog request:

1. **Changes Made** — what changed, grouped by Added / Modified / Removed / Database
2. **Area of Impact** — which layers are affected and what the risk level is
3. **QA Guide** — happy-path test cases + permission notice (if permissions changed) posted as a comment on the ticket

---

## Step 1 — Collect inputs

The user provides either **(A) a GitLab MR URL** or **(B) branch names**.

**Before proceeding**, ask the user via `AskUserQuestion`:

```
What would you like to update?
  1. Both MR and ticket
  2. MR only
  3. Ticket only
```

Store the choice as `<update_target>` and use it throughout to skip irrelevant steps:

| Choice | Branches/MR needed | Ticket needed | MR description updated | Ticket comments posted |
|---|---|---|---|---|
| Both MR and ticket | ✅ | ✅ | ✅ | ✅ |
| MR only | ✅ | ⛔ | ✅ | ⛔ skip Step 6 |
| Ticket only | ✅ (for diff only) | ✅ | ⛔ skip Step 5 | ✅ |

**If user chooses "Ticket only":**
- Still ask for MR URL or branch names (Path A or B) — needed to run the diff and generate changelog content
- MR `iid` from Path A is used for diff only — MR description is never updated
- Follow the **same ticket resolution flow** (Step 2) — scan MR description first, then ask user if not found
- Post Area of Impact + QA Guide to ticket only

### Path A — MR URL provided

Fetch MR metadata:

```bash
# URL format: https://<host>/<group>/<project>/-/merge_requests/<iid>
curl -s -H "PRIVATE-TOKEN: <GITLAB_TOKEN>" \
  "<GITLAB_API>/projects/<GITLAB_PROJECT>/merge_requests/<iid>"
```

Extract from the response:

| Field | Use as |
|---|---|
| `source_branch` | `<current-branch>` |
| `target_branch` | `<compare-branch>` |
| `description` | scan under `Related Issue(s)` for `[Closes [#<n>](<relative_url>)]` pattern → extract `<relative_url>` and prepend GitLab host to construct full URL: `https://<gitlab_host><relative_url>` |
| `iid` | stored for MR comment in Step 5 |
| `web_url` | stored for final summary |

Print:
```
Found MR !<iid>: <title>
  Source:  <current-branch>
  Target:  <compare-branch>
  Ticket:  <ticket_url or "none found">
```

Proceed to **Step 2**.

---

### Path B — Branch names provided or missing

**If branch names are missing**, ask both at once via `AskUserQuestion`:

- **Q1** — "Which is your MR branch? (the branch with new changes)"
  Run `git branch --show-current` to get the current branch and show it as the first option.
  Then populate remaining options from `git branch -r --sort=-committerdate | head -8`. Allow free text.
- **Q2** — "Which branch are you comparing against?"
  Suggest: `dev`, `stage`, `master`, `main`. Allow free text.

**Validate each branch** against the remote (attempt 1):

```bash
git fetch --prune origin 2>/dev/null
git ls-remote --heads origin <branch-name>   # empty output = does not exist
```

If a branch does not exist, show the error and ask again (attempt 2):

```
❌ Branch "<branch-name>" does not exist on the remote.

Available recent branches:
<git branch -r --sort=-committerdate | head -10>

Please provide a valid branch name.
```

If the user provides an invalid branch a **second time**, stop:

```
❌ Invalid branch provided twice. Exiting — please run the command again with a correct branch name.
```

Do **not** continue after two failed attempts.

**Once branches are valid**, search for an existing open MR between them:

```bash
curl -s -H "PRIVATE-TOKEN: <GITLAB_TOKEN>"   "<GITLAB_API>/projects/<GITLAB_PROJECT>/merge_requests?state=opened&source_branch=<current-branch>&target_branch=<compare-branch>"
```

- **MR found** → store `iid`, `web_url`, and scan `description` under `Related Issue(s)` for ticket link using the same pattern as Path A
- **MR not found** → stop:
  ```
  ❌ No open MR found for <current-branch> → <compare-branch>. Please create the MR first.
  ```

Proceed to **Step 2**.

---

## Step 2 — Resolve ticket link

### A — From MR description (Path A only)

Scan the MR `description` field under `Related Issue(s)` for this pattern:

```
[Closes [#<n>](<relative_url>)]
```

Example from a real MR:
```
* [Closes [#8044](/arbisoft/erp/-/work_items/8044)]
```

Extract `<relative_url>` (e.g. `/arbisoft/erp/-/work_items/8044`) and `<n>` (e.g. `8044`).

Construct the full ticket URL by prepending the GitLab host:
```
<ticket_url> = https://<gitlab_host><relative_url>
# e.g. https://gitlab.arbisoft.com/arbisoft/erp/-/work_items/8044
```

Extract the GitLab host from `GITLAB_API` (e.g. `https://gitlab.arbisoft.com/api/v4` → host is `https://gitlab.arbisoft.com`).

Store `<ticket_url>` and `<n>` as `<ticket_iid>`. Proceed to **Step 3**.

### B — No ticket found

If no ticket link was found in the description, ask the user via `AskUserQuestion`:

```
No ticket linked in this MR. Please provide the ticket URL or number.
```

**If the user provides a URL**, verify it exists:

```bash
curl -s -H "PRIVATE-TOKEN: <GITLAB_TOKEN>"   "<GITLAB_API>/projects/<GITLAB_PROJECT>/issues/<iid>"
```

**If the user provides only a number** (e.g. `412`), verify it exists:

```bash
curl -s -H "PRIVATE-TOKEN: <GITLAB_TOKEN>"   "<GITLAB_API>/projects/<GITLAB_PROJECT>/issues/412"
```

If the response is `404`, stop:

```
❌ Ticket #412 does not exist. Please provide a valid ticket URL or number.
```

Do **not** proceed until a valid ticket is confirmed.

---

## Step 3 — Diff analysis

Read credentials from `.claude/settings.local.json`:
- `integrations.gitlab.token` → `GITLAB_TOKEN`
- `integrations.gitlab.api_url` → `GITLAB_API`
- `integrations.gitlab.project` → `GITLAB_PROJECT`

```bash
git fetch origin <current-branch> <compare-branch>

# Commits ahead
git log origin/<compare-branch>..origin/<current-branch> --oneline

# Files changed
git diff origin/<compare-branch>...origin/<current-branch> --stat
git diff origin/<compare-branch>...origin/<current-branch> --name-status

# Full diff (cap at 1000 lines)
git diff origin/<compare-branch>...origin/<current-branch> -- . | head -1000

# Commit messages
git log origin/<compare-branch>..origin/<current-branch> --pretty=format:"%h %s%n%b" | head -100

# Django migrations
git diff origin/<compare-branch>...origin/<current-branch> --name-only | grep migrations/

# Django API files
git diff origin/<compare-branch>...origin/<current-branch> --name-only | grep -E "(urls|views|serializers)\.py"

# React/frontend files
git diff origin/<compare-branch>...origin/<current-branch> --name-only | grep -E "\.(jsx|tsx|js|ts)$"
```

If `<current-branch>` is 0 commits ahead of `<compare-branch>`, stop:
> Nothing to document — `<current-branch>` has no commits that `<compare-branch>` doesn't already have.

**Determine risk level:**

| Level | Condition |
|---|---|
| `High` | DB migrations present, or auth/permissions/settings files changed |
| `Medium` | API endpoint files changed, or shared utilities changed |
| `Low` | UI-only or isolated module changes |

---

## Step 4 — Generate Markdown content

### Changes Made

```markdown
## 1. Changes Made

### Added
- <what> (`<file>`) — <why, from commit message>

### Modified
- <what changed> (`<file>`) — <why>

### Removed
- <what deleted> (`<file>`)

### Database
- **Migration** `<file>` — <what it does>
```

### Area of Impact

```markdown
## 2. Area of Impact

### Backend (Django)
- Apps affected: `<app1>`, `<app2>`
- Models: <list>
- APIs: <list>
- ⚠️ **DB Migration — run `python manage.py migrate` before deploying** _(High Risk)_

### Frontend (React)
- Pages affected: `<route>`
- New components: `<Name>`
- Modified components: `<Name>`

### Config / Environment
- <changes, or "No changes">

### ⚠️ High Risk Items
- <item> _(reason)_
```

Always flag as ⚠️ High Risk: DB migrations · `settings.py` · `.env.example` · `requirements.txt` · auth/permissions/middleware · shared utilities used across multiple apps.

### QA Guide

One happy-path test case per affected area. If permission-related files were changed in the diff, append a plain note for QA — no test case format needed:

```markdown
## 3. QA Guide

### Test Case 1: <title>
- **Module / Area:** <Django app or React page>
- **Precondition:** <required state>
- **Steps:**
  1. <action>
  2. <action>
  3. <action>
- **Expected Result:** <what should happen>

---
```

If DB migrations are present, always add:

```markdown
### Test Case: Migration runs cleanly
- **Precondition:** Staging or fresh DB environment
- **Steps:**
  1. Run `python manage.py migrate`
  2. Check output for errors
  3. Verify new table/column exists in DB
- **Expected Result:** Migration completes without errors

---
```

If permission-related files were changed (e.g. `permissions.py`, `roles`, middleware, decorators), append at the end:

```markdown
### ⚠️ Permissions Changed
The following permission-related files were modified — QA should verify access control behaviour:
- `<file>` — <what changed>
- `<file>` — <what changed>
```

---

## Step 5 — Append Changes Made + Area of Impact to MR description

Fetch the current MR description first:

```bash
curl -s -H "PRIVATE-TOKEN: <GITLAB_TOKEN>" \
  "<GITLAB_API>/projects/<GITLAB_PROJECT>/merge_requests/<iid>"
# read .description field
```

Append both sections below existing content — never replace it:

```bash
curl -s -X PUT \
  -H "PRIVATE-TOKEN: <GITLAB_TOKEN>" -H "Content-Type: application/json" \
  "<GITLAB_API>/projects/<GITLAB_PROJECT>/merge_requests/<iid>" \
  -d "{\"description\": \"<existing description>\\n\\n---\\n\\n<escaped Changes Made markdown>\\n\\n---\\n\\n<escaped Area of Impact markdown>\"}"
```

Confirm HTTP 200 response.

---

## Step 6 — Post Area of Impact + QA Guide as ticket comments (skip if no ticket)

### Comment 1 — Area of Impact

```bash
curl -s -X POST \
  -H "PRIVATE-TOKEN: <GITLAB_TOKEN>" -H "Content-Type: application/json" \
  "<GITLAB_API>/projects/<GITLAB_PROJECT>/issues/<ticket_iid>/notes" \
  -d "{\"body\": \"<escaped Area of Impact markdown>\"}"
```

### Comment 2 — QA Guide

```bash
curl -s -X POST \
  -H "PRIVATE-TOKEN: <GITLAB_TOKEN>" -H "Content-Type: application/json" \
  "<GITLAB_API>/projects/<GITLAB_PROJECT>/issues/<ticket_iid>/notes" \
  -d "{\"body\": \"<escaped QA Guide markdown>\"}"
```

Confirm both return HTTP 201.

---

## Step 7 — Print summary

```
✅ MR Change Log posted

  MR:       !<iid> — <mr_web_url>
  Branches: <current-branch>  →  <compare-branch>
  Ticket:   <ticket_url>
  Commits:  N  |  Files: M  |  Risk: High / Medium / Low

  Appended to MR description:
    • Changes Made   (Added / Modified / Removed / Database)
    • Area of Impact (Backend / Frontend / Config / ⚠️ High Risk)

  Posted as ticket comments:
    • Area of Impact
    • QA Guide       (X happy-path test cases + permission notice if applicable)
```

---

## Hard rules

- **Never run `git merge` or `git push`** — read-only on git; diff only
- **Never print `GITLAB_TOKEN`** to the user
- **Always offer current branch as first option** — run `git branch --show-current` and present it as the first choice when asking for MR branch
- **Always validate branches** with `git ls-remote` — allow 2 attempts maximum, then stop
- **Always verify ticket exists** via API before linking — stop with error if 404
- **Never fabricate a ticket URL** — only use URLs from MR description or user input
- **Never create a ticket automatically** — ticket must already exist and be linked in the MR description
- **Always ask for a ticket** — if no ticket found, ask the user; allow 2 attempts maximum
- **Wrong ticket URL** — if URL does not match, ask user to correct it; one retry only
- **No ticket after 2 attempts** — proceed and post to MR only; skip all ticket steps
- **Never block on ticket** — missing ticket should never prevent the MR from being updated
- **Always ask update target first** — user must choose between Both / MR only / Ticket only before any other step
- **Respect update target** — never post to MR if user chose Ticket only; never post to ticket if user chose MR only
- **Ticket only still needs branches/MR** — always collect MR URL or branch names regardless of update target, to run the diff
- **Ticket only uses same ticket resolution** — scan MR description first, ask user only if not found; never skip Step 2
- **Always use three-dot diff** `git diff origin/<compare>...origin/<current>` — diffs from common ancestor
- **Cap diff at 1000 lines** — summarize by module for large MRs
- **Always list DB migrations explicitly** — even when nothing else is high risk
- **Append Changes Made + Area of Impact to MR description** — never replace existing content; fetch first then append
- **Post Area of Impact as ticket comment** — in addition to MR description
- **Post QA Guide as ticket comment** — not on the MR
- **QA Guide — happy path only** — one test case per affected area; if permission files changed, append a plain ⚠️ Permissions Changed note listing the modified files; never write a permission test case
