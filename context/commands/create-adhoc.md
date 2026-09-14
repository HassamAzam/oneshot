---
description: Stash current changes, create (or reuse) an Adhoc branch from master, apply changes, commit, and open an MR against master with the Adhoc label.
argument-hint: "[optional commit message]"
---

# /create-adhoc — Create Adhoc Branch and MR

## When to use

**Only invoke this command when the user explicitly:**
- types `/create-adhoc`, or
- uses the word "adhoc" (e.g. "create an adhoc MR", "put this on an adhoc branch"), or
- explicitly asks to target `master` instead of `dev`.

**Do NOT invoke this command** for a generic "create an MR" or "open an MR" request — those should use the `mr-metadata` skill on the current feature branch targeting `dev`.

Takes your current uncommitted changes (staged + unstaged), finds or creates an `Adhoc-<date>` branch off an up-to-date master, applies the changes, commits, and opens an MR against master.

## Step 0 — Capture current state

Run all of these in parallel:

```bash
git status --short
git diff HEAD            # all changes (staged + unstaged)
git diff --staged        # staged only
git stash list           # any existing stashes
git branch --show-current
```

If there are **no** uncommitted changes (working tree clean), stop and tell the user:
> No uncommitted changes found. Nothing to create an adhoc for.

Otherwise, note the full diff — you will need it to re-apply later.

---

## Step 1 — Scan for recent Adhoc branches

Look for any local or remote branches that match `Adhoc-YYYY-MM-DD` where the date is within the **last 5 days including today**:

```bash
# Today's date
date +%Y-%m-%d

# List all branches (local + remote) matching the patterns
git fetch --prune 2>&1 || true
git branch -a --format='%(refname:short)' | grep -E '^(origin/)?Adhoc-[0-9]{4}-[0-9]{2}-[0-9]{2}$'
```

For each matching branch, compute its date from the name and include it only if the date is within the last 5 days (inclusive of today). For each candidate branch, collect:

```bash
# Commits in master not in this branch (i.e. what this branch is missing)
git log origin/master --not <branch> --oneline 2>/dev/null || git log master --not <branch> --oneline 2>/dev/null

# Commits in this branch not in master (i.e. what this branch has ahead)
git log <branch> --not origin/master --oneline 2>/dev/null || git log <branch> --not master --oneline 2>/dev/null
```

---

## Step 2 — Present candidates and ask

If **one or more** candidates were found, display a table like this and ask the user before proceeding:

```
Found recent Adhoc branches:

  #  Branch              Behind master       Ahead of master
  1  Adhoc-2026-04-13    2 commits missing   0 commits ahead
     Missing: abc1234 feat: user fix
              def5678 fix: payroll bug
  2  Adhoc-2026-04-12    0 commits missing   1 commit ahead
  N  Create new branch   Adhoc-2026-04-14 (from fresh master pull)

Which branch should I use? Enter the number, or N to create a new one.
```

Wait for the user's answer before continuing.

### Step 2a — If user picks an existing branch

```bash
git stash push -u -m "adhoc-wip-$(date +%s)"
git checkout <chosen-branch>
```

If the branch is **behind master** (has missing commits), tell the user exactly which commits are missing and ask:

```
This branch is missing N commits from master:
  - abc1234 feat: ...
  - def5678 fix: ...

Should I rebase this branch onto master (bring it up to date) before applying your changes?
Reply yes or no.
```

If **yes**: `git rebase origin/master` (or `git rebase master` if no remote), handle any conflicts by surfacing them to the user and stopping.
If **no**: proceed with the branch as-is.

Then pop the stash:
```bash
git stash pop
```

Skip to **Step 4**.

### Step 2b — If user picks "create new" (or no candidates were found)

Proceed to **Step 3**.

---

## Step 3 — Create new Adhoc branch from master

```bash
# Save the changes
git stash push -u -m "adhoc-wip-$(date +%s)"

# Update master
git fetch origin
git checkout master
git pull origin master

# Create new branch
BRANCH_NAME="Adhoc-$(date +%Y-%m-%d)"
git checkout -b "$BRANCH_NAME"

# Restore the changes
git stash pop
```

If `git stash pop` produces merge conflicts, surface them to the user and stop — do not commit in a conflict state.

---

## Step 4 — Determine commit message

If `$ARGUMENTS` is non-empty, use it as the commit message.

Otherwise, inspect `git diff HEAD` (after the stash pop) and generate a short conventional commit message following the project format (`feat:`, `fix:`, `chore:`, etc.). Show the user the proposed message and ask:

```
Proposed commit message:
  fix: <generated description>

Looks good? Reply yes to use it, or type a different message.
```

Wait for confirmation before committing.

---

## Step 5 — Stage and commit

```bash
git add -A
git commit -m "<confirmed message>"
```

If the pre-commit hook fails, show the full hook output and stop. Do **not** use `--no-verify`.

---

## Step 6 — Push the branch

```bash
git push -u origin <branch-name>
```

---

## Step 7 — Create MR against master via GitLab API

Read credentials from `.claude/settings.local.json`:
- `integrations.gitlab.token` → `GITLAB_TOKEN`
- `integrations.gitlab.api_url` → `GITLAB_API`
- `integrations.gitlab.project` → `GITLAB_PROJECT` (URL-encoded project path or numeric ID)

If any are missing, stop and tell the user to add them under `integrations` in `.claude/settings.local.json`.

Apply the `mr-metadata` skill to produce both the title and description:

**Title** — strip the conventional-commit prefix and title-case the remainder (see `mr-metadata` skill Rule 1).

**Description** — build the body below, placing the closes line at the **top**, then follow the ticket-finding steps in `mr-metadata` skill Rule 2 (session context → GitLab search + comments → ask user):

```
[closes <ticket_url found via mr-metadata skill>]

## What
<one paragraph summarising the change, derived from the diff>

## Why
Ad-hoc release — applied via /create-adhoc command.

## Checklist
- [ ] Tested locally
- [ ] No migrations required (or migrations included)
```

**If the branch already has an existing MR**, fetch its current description first and follow the existing-MR update rules in the `mr-metadata` skill (combine What sections, append ticket to closes line) instead of creating a new MR.

Create the MR:

```bash
curl -s -X POST \
  -H "PRIVATE-TOKEN: <GITLAB_TOKEN>" \
  -H "Content-Type: application/json" \
  "<GITLAB_API>/projects/<GITLAB_PROJECT>/merge_requests" \
  -d '{
    "source_branch": "<branch-name>",
    "target_branch": "master",
    "title": "<mr-title skill output — NOT the raw commit message>",
    "description": "<mr description>",
    "labels": "Adhoc",
    "remove_source_branch": true
  }'
```

On success, print:

```
Adhoc branch:  <branch-name>
MR:            <web_url>
Target:        master
Label:         Adhoc
```

On failure, print the full error response and the manual URL to create the MR.

---

## Hard rules

- **Never commit** in a conflict state (after a failed stash pop or rebase conflict). Surface the issue and stop.
- **Never skip pre-commit hooks** (`--no-verify` is forbidden).
- **Never print** `GITLAB_TOKEN` to the user.
- **Always ask** before rebasing an existing branch onto master — never do it silently.
- **Always ask** for commit message confirmation unless `$ARGUMENTS` was provided.
- **MR target is always `master`** — not `dev`, not `stage`.
- **MR label is always `Adhoc`**.
- If on the `master` branch with clean state when the command starts, still stash (stash will be a no-op) and proceed normally.
