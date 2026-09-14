---
description: Run the ERP code review skill on local uncommitted changes, the current branch vs dev, or a specific GitLab MR.
argument-hint: "[<MR-id> | <branch-name> | blank for local diff]"
---

# /erp-review — ERP Code Review

> For full MR review with GitLab posting, use `/erp-review-mr <id>` instead.

Review scope is determined by `$ARGUMENTS`:

- **No argument** → review local uncommitted changes (`git status`, `git diff`, `git diff --staged`)
- **A number** (e.g. `1234`) → treat as GitLab MR ID → delegate to `mr-review-agent`
- **A branch name** (e.g. `ibrahim/leaves-approver`) → `git diff origin/dev...<branch>`
- **`staged`** → `git diff --staged` only
- **`dev`** / **`stage`** / **`master`** → `git diff origin/<target>...HEAD`

## Workflow

1. **Resolve scope** from `$ARGUMENTS` using the rules above. Print the scope you picked in one line.
2. **Invoke the `erp-code-review` skill** with that diff as input. The skill handles:
   - Layer classification (backend / frontend / migrations / tests)
   - Layered checklist (only loads layers present in the diff)
   - Impact analysis (what / blast radius / risk)
   - Structured output with `[BLOCKER] / [SUGGESTION] / [NITPICK]`
3. **If the argument looks like an MR ID** (pure number), call `mr-review-agent` instead — it fetches MR metadata via `mcp__gitlab`, runs pre-checks (ticket, template, target branch, size), then calls the skill.
4. **Output** the skill's paste-ready review. Do **not** post to GitLab without explicit user approval.

## Hard rules

- Never post comments directly to GitLab. Human gate required.
- Never invent rules outside `.claude/rules/`.
- Silence = pass. Do not list checklist items that passed.
- If the diff is clean, one line — "clean, no findings" — and stop.

## References

- Skill: `.claude/skills/erp-code-review/SKILL.md`
- Agent: `.claude/agents/mr-review-agent.md`
- Standards: `.claude/rules/` (split by domain)
- MR template: `.gitlab/merge_request_templates/default.md`
