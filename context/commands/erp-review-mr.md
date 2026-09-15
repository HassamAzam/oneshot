---
description: Review a GitLab MR end-to-end and post the review as comments after human approval. Uses the GitLab MCP.
TRIGGER: user explicitly asks to "review" an MR or "post review comments" — the word "review" must be present in the request.
SKIP: user is creating an issue, linking an MR to a ticket, fetching MR details, updating an MR description, or any task where an MR URL is incidentally mentioned but review is not requested.
argument-hint: "<MR-id | MR-url>"
---

# /erp-review-mr — Review and post to a GitLab MR

Full loop: fetch MR → run ERP code review → show findings → wait for approval → post inline comments and MR-level summary to GitLab.

**Requires**: GitLab MCP server configured and connected (tool prefix `mcp__gitlab__*`). If no GitLab MCP tools are listed in the current session, stop and tell the user to enable it.

## Step 1 — Parse target

Read `$ARGUMENTS`:
- Bare integer (e.g. `1234`) → MR IID in the current repo's default GitLab project
- Full URL (e.g. `https://gitlab.arbisoft.com/<group>/<project>/-/merge_requests/1234`) → parse project path + IID
- Anything else → ask the user which MR they mean, don't guess

Derive the GitLab project path from `git remote get-url origin` if not in the URL.

## Step 2 — Fetch MR via GitLab MCP

Use the GitLab MCP to fetch — use whatever the server exposes. Typical tool names:
- `mcp__gitlab__get_merge_request` or equivalent
- `mcp__gitlab__get_merge_request_diffs` / `get_merge_request_changes`
- `mcp__gitlab__list_merge_request_discussions` (to avoid duplicate comments)

Capture:
- Title, description, author, source branch, target branch
- Full diff (all changed files + hunks)
- Existing discussions (so we don't re-post the same comment)
- The latest HEAD SHA (`diff_refs.head_sha`) — required to anchor inline comments

## Step 3 — Pre-checks (MR-level BLOCKER candidates)

Before diving into code:
- **GitLab ticket** referenced in branch name OR title OR description? Missing → BLOCKER.
- **MR template** sections filled per `.gitlab/merge_request_templates/default.md`? Empty sections → BLOCKER.
- **Target branch** sane? `dev` is default; `stage`/`master` only for ad-hoc releases — if unexpected, flag a SUGGESTION to confirm with author.
- **Size** > 400 LOC with multiple unrelated themes → SUGGESTION to split.
- **CI status** (if MCP exposes it) failing → BLOCKER to land, but review can still proceed.

## Step 3.5 — Fetch the linked ticket (for spec-match review)

If a GitLab ticket reference was found in Step 3 (branch / title / description), fetch the ticket body via the GitLab MCP. Otherwise skip this step — `spec-conformance-agent` will be skipped downstream.

Parse the reference into `(project_path, iid)`. Most tickets live in the same project as the MR; some live in a sibling project (e.g. an issues-only repo). If the reference is bare (e.g. `#1234` or `LFA-1234`) and the same-project lookup fails, try the canonical issues project for this group before giving up.

Typical MCP tool: `mcp__gitlab-mcp__get_issue` (or whatever the connected server exposes).

Capture:
- Ticket title, description, labels
- Any explicit **acceptance criteria** / **Definition of Done** sections
- Attached screenshots or mockup links (note their presence — don't try to render them)
- Comments only if the description is empty and the AC clearly lives in a comment

Build a `ticket_context` blob with these fields:

```
ticket_id:    <project>/-/issues/<iid>
title:        <ticket title>
description:  <full description, markdown preserved>
labels:       <comma-separated labels>
attachments:  <"screenshot present" / "mockup link present" / "none">
```

If the ticket fetch fails (404, permission denied, MCP error):
- Do NOT block the review — the rest of the pipeline still runs
- Add a one-line **SUGGESTION** to the MR-level summary: "Could not fetch linked ticket `<id>` — spec match was not verified"
- Skip `spec-conformance-agent` downstream

Never paste the full ticket body into the final GitLab review output — quote only the bullets that are cited.

## Step 4 — Run the erp-code-review skill

Delegate the layered review to the `erp-code-review` skill. The skill is a thin orchestrator that dispatches specialist reviewer agents **in parallel** (all Sonnet):

- `backend-reviewer-agent` — Django/Python (SOLID, ORM, thin views, serializer hygiene, backend security)
- `frontend-reviewer-agent` — React/JS (re-render bugs, hooks, container/component split, inline styles, FE perf)
- `util-reuse-agent` — DRY / prior-art hunt when the diff introduces helper-shaped functions
- `spec-conformance-agent` — diff vs. ticket (acceptance criteria, scope creep) — only when `ticket_context` from Step 3.5 is present

The skill aggregates findings, sorts by severity, dedupes overlap, and produces an impact analysis + `[BLOCKER] / [SUGGESTION] / [NITPICK]` list with concrete fixes.

Pass the diff from Step 2 and the `ticket_context` from Step 3.5 (if any) as input. Do **not** reimplement the checklist here.

## Step 5 — De-duplicate against existing discussions

For each finding, check if an equivalent comment already exists in the MR's discussions:
- Same file + same line ± 2 lines + same severity
- Or substring match on the problem description

Skip findings that are already raised. Include a note in the output: "Skipped N already-raised findings".

## Step 6 — Show the review for approval

Output format:

```
## MR !<iid> — <title>
Source: <source> → Target: <target>
Author: <author>

## Impact
<2–4 sentences: what changed, blast radius, risk>

## MR-level comment (will be posted once)
[BLOCKER items] + [pre-check failures] + Impact summary

## Inline comments (will be posted one per finding)
1. [BLOCKER]  <path>:<line> — <problem>
   Fix: <concrete suggestion>
2. [SUGGESTION] <path>:<line> — <problem>
   Fix: <concrete suggestion>
...

## Skipped
- <already-raised finding>

## Plan
- MR-level comment: 1
- Inline comments: N
- Target: <gitlab-url>
```

Then ask **explicitly**:

> Post this review to GitLab? Reply `yes` to post all, `no` to cancel, or list the numbers to keep (e.g. `1,3,5`).

**Do NOT post anything before this approval.** Human gate is mandatory.

## Step 7 — Post after approval

If approved:

1. **MR-level comment** — post the Impact + BLOCKER summary as a single MR note. Typical MCP tool: `mcp__gitlab__create_merge_request_note` or `create_note`.

2. **Inline comments** — for each finding, post a position-anchored discussion. Typical MCP tool: `mcp__gitlab__create_merge_request_discussion` with a `position` object:
   ```
   position: {
     base_sha: <diff_refs.base_sha>,
     start_sha: <diff_refs.start_sha>,
     head_sha: <diff_refs.head_sha>,
     old_path: <path>,
     new_path: <path>,
     position_type: "text",
     new_line: <line>  // or old_line for removed lines
   }
   ```
   If the GitLab MCP doesn't expose position-anchored comments, fall back to a single combined MR-level note with all findings.

3. **Rate-limit**: post sequentially with a small delay (1–2s) between calls. Do not parallelize — GitLab will 429.

4. **Report**: after posting, print the count of comments posted, the MR URL, and any failures.

## Step 8 — Failure handling

- If the GitLab MCP is unavailable → stop, tell the user, print the review text so it can be posted manually.
- If a single comment fails to post → continue with the rest, report at the end which ones failed and why.
- Never retry an MCP call more than once — surface the error instead.

## Hard rules

- **Human gate is mandatory** — never post without explicit approval in this turn
- **No duplicate comments** — always de-dup against existing discussions
- **Never post the token** or any env var to GitLab
- **Severity labels must appear** in every posted comment body: `[BLOCKER]`, `[SUGGESTION]`, `[NITPICK]`
- **Voice**: direct, terse, always pair problem with concrete fix — same as the skill

## References

- Review skill: `.claude/skills/erp-code-review/SKILL.md` (DRY check in Step 3a, SOLID in Step 3b)
- MR agent: `.claude/agents/mr-review-agent.md`
- Spec match: `.claude/agents/spec-conformance-agent.md`
- Standards: `.claude/rules/` (split by domain)
- MR template: `.gitlab/merge_request_templates/default.md`
