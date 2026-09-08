---
name: mr-metadata
description: This skill MUST be applied whenever a GitLab or GitHub merge request / pull request is being created — whether via /create-adhoc, /erp-review-mr, a direct API call, gh pr create, or any other path. It governs how the MR title is written and how the closing ticket is found and linked in the description.
version: 1.0.0
---

# MR Metadata Skill

Covers three mandatory rules for every MR/PR that is created:

1. **Title** — human-readable summary, never a raw commit message
2. **Ticket link** — every MR description must contain a `[closes <ticket_url>]` line
3. **Scope split** — tooling/docs changes and code changes must ship in separate MRs

---

## Rule 1 — MR Title

**The title must summarise the whole branch's changes — not just the last commit.**

A branch can have 1 commit (`/create-adhoc` style) or 30+ (a multi-phase feature). The MR title goes in front of reviewers, dashboards, and Slack notifications — it has to describe what the MR *as a whole* does, not whatever happened to land in the last commit (which is often a small lint fix or polish pass).

### Algorithm

1. **If the user supplied a title explicitly**, use it as-is. Skip the rest.
2. **Otherwise, derive the title from the branch diff, not the last commit:**
   - Look at the full commit list on the branch (`git log <base>..HEAD`).
   - If the branch has **1 commit**, that commit message is the basis (apply step 3-5 below).
   - If the branch has **multiple commits**, look at the *body of work* — what feature was built, what bug was fixed, what was refactored — and write a short summary (under 70 chars). Don't paste the last commit. Don't paste the first commit. Synthesise.
3. Strip any leading conventional-commit prefix: `^(feat|fix|chore|refactor|test|docs|style|perf|ci|build|revert)(\(.+?\))?!?:\s*`
4. Strip any trailing ticket reference in parentheses: `\s*\(#\d+\)$`
5. Title-case the result (capitalise the first letter of each significant word; keep short prepositions/articles — in, of, for, a, the — lowercase unless they open the title).

### Examples — single commit

| Last commit message                                              | MR title                                                  |
|------------------------------------------------------------------|-----------------------------------------------------------|
| `fix: coerce null comments to empty string on flagged choice`    | `Coerce Null Comments to Empty String on Flagged Choice`  |
| `feat: add leave balance carry-forward for part-time staff`      | `Add Leave Balance Carry-Forward for Part-Time Staff`     |
| `chore: remove unused celery task for invoice reminders`         | `Remove Unused Celery Task for Invoice Reminders`         |
| `refactor: extract payroll proration into service layer`         | `Extract Payroll Proration into Service Layer`            |

### Examples — multi-commit branch

| Last commit                                          | All commits in branch (summary)                                  | MR title                                                                  |
|------------------------------------------------------|-------------------------------------------------------------------|---------------------------------------------------------------------------|
| `chore: bump pylint score to 10/10`                  | feature: monthly audit (30 commits — service, rules, templates, tests) | `Monthly Project-Log Audit (Team + Per-Person)`                           |
| `fix: typo in placeholder text`                      | feature: rewrite leaves request flow with new approval chain (12 commits) | `Rewrite Leaves Request Flow With New Approval Chain`                     |
| `test: add coverage for edge case`                   | refactor: split payroll service module into 4 sub-services (8 commits) | `Split Payroll Service into Sub-Services`                                  |

In each case the LAST commit is misleading on its own — the title must capture the whole branch's intent.

### How to write a multi-commit summary

- Read the commit subjects (`git log <base>..HEAD --format='%s'`) and identify the recurring theme.
- Identify the *one* user-facing or system-facing thing the MR delivers.
- Drop chore / lint / cleanup commits from your synthesis — they're support work, not the deliverable.
- If the branch genuinely has two unrelated themes, that's a sign the branch should be split into two MRs — flag this to the user instead of writing a hyphenated title.

### Title length

- Under 70 characters where possible.
- Never paste a multi-sentence summary into the title; that's what the description is for.

---

## Rule 2 — Closing Ticket Link

Every MR description **must** end with:

```
[closes <ticket_url>]
```

Where `<ticket_url>` renders with the ticket number as the link text, e.g.:

```
[closes https://gitlab.example.com/group/project/-/issues/412]
```

Work through the following steps in order, stopping as soon as a relevant ticket is found.

### Step A — Check current session context

Scan the current conversation for any GitLab issue URLs or ticket references that are **relevant to the changes in this MR**. Relevance means the ticket describes a bug, feature, or task that the diff directly addresses.

- Do **not** pick a ticket just because it appears in the session — it must be topically related to the code changes.
- If a relevant ticket is found here, use it and skip Steps B–D.

### Step B — Search GitLab for recent tickets

Read credentials from `.claude/settings.local.json`:
- `integrations.gitlab.token` → `GITLAB_TOKEN`
- `integrations.gitlab.api_url` → `GITLAB_API`
- `integrations.gitlab.project` → `GITLAB_PROJECT`

Fetch issues updated in the last 10 days (keeps the result set small and relevant):

```bash
# macOS-compatible date subtraction
SINCE=$(date -u -v-10d +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -d '10 days ago' +%Y-%m-%dT%H:%M:%SZ)

curl -s \
  -H "PRIVATE-TOKEN: <GITLAB_TOKEN>" \
  "<GITLAB_API>/projects/<GITLAB_PROJECT>/issues?state=opened&updated_after=$SINCE&per_page=50&order_by=updated_at&sort=desc"
```

For each returned issue, read its `title` and `description` and assess relevance to the MR changes. Do not stop at titles — descriptions often contain the detail needed to match.

### Step C — Read comments on candidate tickets

If any ticket from Step B looks potentially related but not conclusively (e.g. a feature ticket whose description doesn't mention the specific bug being fixed), fetch and read that ticket's comments too. QA engineers often report bugs as comments on a feature ticket rather than opening a separate issue.

```bash
curl -s \
  -H "PRIVATE-TOKEN: <GITLAB_TOKEN>" \
  "<GITLAB_API>/projects/<GITLAB_PROJECT>/issues/<issue_iid>/notes?per_page=50&sort=asc"
```

Scan the note bodies for mentions of the exact symptom, model name, field name, or code area changed in this MR. If a comment confirms relevance, use that ticket.

### Step D — Ask the user

If no relevant ticket was found after Steps A–C, ask:

```
I couldn't find a relevant GitLab ticket for these changes.

Options:
  1. Paste the ticket URL and I'll link it.
  2. I'll create a new GitLab issue for these changes and link it automatically.

Which do you prefer?
```

- If the user pastes a URL, use it directly.
- If the user chooses option 2, create a new issue via the GitLab API using a title and description derived from the diff, then use the new issue's `web_url` as the closes link.

```bash
curl -s -X POST \
  -H "PRIVATE-TOKEN: <GITLAB_TOKEN>" \
  -H "Content-Type: application/json" \
  "<GITLAB_API>/projects/<GITLAB_PROJECT>/issues" \
  -d '{
    "title": "<issue title derived from MR title>",
    "description": "<brief description of the change and why it is needed>"
  }'
```

---

## Placing the Closes Line in the MR Description

Place the closes line at the **very top** of the description, before all other content:

```markdown
[closes https://gitlab.example.com/group/project/-/issues/412]

## What
<summary of change>

## Why
<reason>

## Checklist
- [ ] Tested locally
- [ ] No migrations required (or migrations included)
```

### Updating an existing MR description

When adding new changes to an MR that already has a description (e.g. an existing Adhoc branch with prior commits):

1. **Do not replace the existing description.** Fetch the current description first via the GitLab API.
2. **Append the new ticket** to the existing closes line — never remove a previously linked ticket:
   - Before: `[closes <url_A>]`
   - After: `[closes <url_A> <url_B>]`
3. **Combine the What sections** — add a new numbered or labelled entry for each set of changes rather than overwriting:
   ```markdown
   [closes <url_A> <url_B>]

   ## What

   **Fix 1 — <title of original change>**
   <original summary>

   **Fix 2 — <title of new change>**
   <new summary>

   ## Why
   Ad-hoc release — applied via /create-adhoc command.

   ## Checklist
   - [ ] Tested locally
   - [ ] No migrations required (or migrations included — note which fix requires them)
   ```

---

## Exception — Automated docs / chore-sync MRs

Some MRs are opened by a non-interactive automation rather than a person or a
coding agent — e.g. the docs-sync middleware that regenerates `CLAUDE.md` files
on a push to master, on branches named `chore/claude-md-sync-*`. These have **no
originating ticket**, run where the user cannot be prompted, and execute in a
sandbox with **no GitLab token and no GitLab egress** — they reach GitLab only
through their own middleware's HTTP endpoints (`file/` to read, `issue/` to
create the closing ticket, `mr/` to open the MR). They never call the GitLab
REST API directly.

For such MRs:

- **Rule 1 (title)** applies in full — strip any prefix and title-case a clear,
  human-readable summary.
- **Rule 2 (closes line)** applies, with one substitution: skip Steps A–D (no
  user to ask, no pre-existing ticket), and instead create the closing ticket by
  POSTing the title/description to the middleware's `issue/` endpoint. Then place
  the returned `[closes <issue_url>]` at the top of the MR description per the
  normal placement rule. The ticket is still created and linked — only *how* it
  is obtained changes (a mediated endpoint, not the agent's own API call).

## Rule 3 — Split MRs by Concern

If the branch's diff touches BOTH of the following buckets, open **two separate MRs**, one per bucket:

- **Tooling / docs / agent config:** any file under `.claude/**` (skills, commands, agents, settings), root `CLAUDE.md`, app-level `apps/*/CLAUDE.md`, anything under `rules/**`, or `docs/**`.
- **Application code:** everything else — `apps/**` (excluding the `CLAUDE.md` carve-out above), `frontend/**`, `common/**`, `hrdb/**`, migrations, tests, fixtures.

**Why:** the two buckets are reviewed by different audiences with different concerns. Code MRs are reviewed for correctness, performance, and security. Skill/doc MRs are reviewed for tooling fit and workflow impact. Bundling them creates noise in both reviews and slows them down.

### Algorithm — run BEFORE creating the MR

1. Compute the diff against the target branch:
   ```bash
   git diff --name-only origin/<target-branch>..HEAD
   ```
2. Classify each file into `tooling` or `code` per the buckets above.
3. If both buckets are non-empty:
   - **Stop. Do not create a single MR.**
   - Report the split to the user, listing the files in each bucket.
   - Propose a split workflow:
     ```
     This branch mixes tooling/docs changes with code changes. I'll split them into two MRs:

     MR 1 (code):     <list of code files>
     MR 2 (tooling):  <list of tooling/docs files>

     Plan:
       1. Identify the commits that belong to each bucket.
       2. Create a new branch off the same base.
       3. Cherry-pick the tooling/docs commits onto the new branch.
       4. Reset this branch to drop those commits (keep code-only).
       5. Push both branches and open two MRs.

     Proceed?
     ```
   - Wait for explicit user approval before doing any rewrite operations (force-push, reset, cherry-pick across branches).

### Exception — explicit override

If a code change MUST ship together with a skill/doc update (e.g., a new agent that the docs need to describe in the same release), the user can override Rule 3 with explicit confirmation. In that case, note the override reason in the MR description:

```markdown
> **Scope override:** this MR ships <code change> together with <skill/doc update>
> because <reason>. Per `mr-metadata` Rule 3, normally these would be split.
```

### Retroactive split

If a branch is already pushed and the MR is open when the violation is discovered, ask the user whether to split it now (recommended) or let it ride. If splitting:

1. Branch off the current branch.
2. On the new branch, `git reset --soft <base>` and re-commit only the tooling/docs files.
3. On the original branch, `git revert` the tooling/docs commits, or `git rebase -i` to drop them, then force-push (with user confirmation).

---

## Scope

These rules apply to **every** MR/PR creation path:
- `/create-adhoc` command
- Any direct `curl … /merge_requests` or `curl … /pulls` call
- `gh pr create`
- Any agent (orchestrator, frontend-agent, backend-agent, qa-agent, etc.) that opens a PR/MR as part of its work

**Hard rules:**
- Never fabricate a ticket URL — only use URLs confirmed via session context, the GitLab API response, or user input.
- Never skip the closes line — if no ticket exists yet, create one (after asking) rather than omitting it. (Exception: the automated docs / chore-sync case above creates the ticket non-interactively, without asking — it still gets a closes line.)
- Never pick an unrelated ticket just to satisfy the requirement.
- Never print `GITLAB_TOKEN` to the user.
