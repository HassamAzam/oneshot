---
description: Create a GitLab MR from the current branch into dev (default), using mr-metadata skill for title and ticket linking. Supports dev/stage targets natively; hands off to /create-adhoc if the user wants master.
argument-hint: "[optional MR title or description hint]"
---

# /create-mr — Create a Merge Request

## When to use

Use this command for **any generic MR creation request** — "create an MR", "open an MR", "make a PR", etc. This is the default MR command. Only use `/create-adhoc` when the user explicitly asks for an adhoc branch.

---

## Step 0 — Confirm target branch with user

Get the current branch first:

```bash
git branch --show-current
```

Then tell the user:

```
I'll create an MR from <current-branch> into dev. Want to target a different branch? (stage / master)
```

Wait for the user's response before continuing.

- If the user says **master** (or "adhoc", "into master"): **stop here** and hand off to `/create-adhoc` by invoking the `create-adhoc` command as a subagent, passing along any `$ARGUMENTS` the user provided. Do not proceed with the steps below.
- If the user says **stage**: set `TARGET_BRANCH=stage` and continue to Step 1.
- If the user says **no** / **dev** / anything that confirms the default: set `TARGET_BRANCH=dev` and continue to Step 1.

---

## Step 1 — Gather branch state

Run in parallel:

```bash
git status --short
git log origin/<TARGET_BRANCH>..HEAD --oneline 2>/dev/null || git log <TARGET_BRANCH>..HEAD --oneline
git diff origin/<TARGET_BRANCH>...HEAD --stat 2>/dev/null || git diff <TARGET_BRANCH>...HEAD --stat
```

If there are **no commits ahead of `<TARGET_BRANCH>`**, stop and tell the user:

> This branch has no commits ahead of <TARGET_BRANCH>. Nothing to open an MR for.

---

## Step 2 — Push the branch if needed

Check whether the current branch has a remote tracking branch and is up to date:

```bash
git status -sb
```

If the branch has no upstream or has unpushed commits, push it:

```bash
git push -u origin <current-branch>
```

If the push fails, surface the full error and stop.

---

## Step 3 — Build MR title and description using mr-metadata skill

Apply the `mr-metadata` skill in full:

**Title** — derive from the last commit message or `$ARGUMENTS` if provided, following Rule 1 of the skill (strip conventional-commit prefix, title-case the result).

**Description** — follow Rule 2 of the skill to find the closing ticket (session context → GitLab search → ask user), then build:

```markdown
[closes <ticket_url>]

## What
<one paragraph summarising what changed, derived from the diff>

## Why
<one paragraph explaining the motivation, derived from the ticket or commit messages>

## Checklist
- [ ] Tested locally
- [ ] No migrations required (or migrations included)
```

---

## Step 4 — Create the MR via GitLab API

Read credentials from `.claude/settings.local.json`:
- `integrations.gitlab.token` → `GITLAB_TOKEN`
- `integrations.gitlab.api_url` → `GITLAB_API`
- `integrations.gitlab.project` → `GITLAB_PROJECT`

If any are missing, stop and tell the user to add them under `integrations` in `.claude/settings.local.json`.

```bash
curl -s -X POST \
  -H "PRIVATE-TOKEN: <GITLAB_TOKEN>" \
  -H "Content-Type: application/json" \
  "<GITLAB_API>/projects/<GITLAB_PROJECT>/merge_requests" \
  -d '{
    "source_branch": "<current-branch>",
    "target_branch": "<TARGET_BRANCH>",
    "title": "<title from Step 3>",
    "description": "<description from Step 3>",
    "remove_source_branch": false
  }'
```

On success, print:

```
Branch:   <current-branch>
MR:       <web_url>
Target:   <TARGET_BRANCH>
```

On failure, print the full error response and the manual URL to create the MR.

---

## Hard rules

- **Default target is `dev`** — only change if the user explicitly says so.
- **master requests always hand off to `/create-adhoc`** — never create a master-targeted MR directly in this command.
- **Always ask** about the target branch before doing anything else (Step 0).
- **Never fabricate a ticket URL** — follow mr-metadata skill Rule 2 exactly.
- **Never skip the closes line** — if no ticket is found, ask or create one per the skill.
- **Never print** `GITLAB_TOKEN` to the user.
- **Never force-push** or use destructive git commands.
