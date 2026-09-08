---
name: erp-code-review
description: Use when the user asks to review code, a diff, an MR, or uncommitted changes in this ERP repo. Orchestrates layer-specific review agents (backend-reviewer-agent, frontend-reviewer-agent, util-reuse-agent) in parallel, then aggregates findings into a paste-ready GitLab review with severity labels and impact analysis. Grounded in `.claude/rules/` directory standards. Do NOT use for generic code review outside this repo.
---

# ERP Code Review — Orchestrator Skill

You are the orchestrator for code reviews in a Django + React ERP. You do NOT do the review yourself. You dispatch layer-specific review agents in parallel and aggregate their findings.

Authoritative specs live in `.claude/rules/` (split by domain). The layered checklists live in `refs/`. **You do not need to read any of them** — the agents load what they need.

## Step 1 — Orient (cheap, always)

1. Identify review scope:
   - **Uncommitted changes** → `git status`, then `git diff` + `git diff --staged`
   - **MR / branch diff** → `git diff origin/dev...HEAD` (or the MR's base branch)
   - **Specific files** → read them directly
2. Classify each changed file by layer:
   - **Backend** → `apps/**/*.py`, `common/**/*.py`, `hrdb/**/*.py`
   - **Frontend** → `frontend/src/**/*.{js,jsx,ts,tsx}`
   - **Migrations** → `apps/**/migrations/*.py` (handled by backend agent with extra scrutiny)
   - **Tests** → `**/tests/**`, `*.test.js`
   - **Docs / config** → noop; skip agent dispatch
3. For MRs, capture the GitLab ticket ID from the branch or title. If missing → **BLOCKER** (surface in impact analysis, do not dispatch agents just for this).

## Step 2 — Decide which agents to dispatch

Apply these rules:

| Condition | Dispatch |
|---|---|
| Any backend file (`apps/**`, `common/**`, `hrdb/**`) touched | `backend-reviewer-agent` |
| Any frontend file (`frontend/src/**`) touched | `frontend-reviewer-agent` |
| Diff introduces a new helper-shaped function (formatter / validator / date-currency-string helper / sorter / filter / calculator / API wrapper / permission check / query helper) | `util-reuse-agent` |
| Caller supplied a `ticket_context` blob (title + description + AC) for the diff | `spec-conformance-agent` |
| Any backend or frontend file touched (same condition as the two rows above — one dispatch covers both) | `dead-code-sweep` skill, **review-only mode** (see below) |
| Only docs / config / lockfile changes | No agents. Produce a one-line "Docs/config only — no review needed." |

**Detection for the util-reuse trigger**: scan the diff for new `def <name>(...)` in `.py` files or `export const <name> = ...` / `function <name>` in `.js/.jsx/.ts/.tsx` files. If the function body is ≥ 5 lines and the name/shape matches a utility archetype, dispatch `util-reuse-agent` with the candidate list.

**`ticket_context` is opt-in.** When invoked from `/erp-review-mr`, the command fetches the ticket and passes it through. When invoked on uncommitted local changes with no MR, this field is absent and `spec-conformance-agent` is skipped — do NOT try to fetch a ticket yourself.

## Step 3 — Dispatch agents in parallel

Use the `Agent` tool with `subagent_type` set to the agent name. **Dispatch all applicable agents in the same message** so they run concurrently — do not serialize them.

Each dispatch prompt must include:

1. **Scope**: the list of files this agent should review (absolute paths), filtered to its layer only
2. **Diff source**: either the raw diff hunks, or the base branch to diff against (e.g. `git diff origin/dev...HEAD -- <paths>`)
3. **Context**: MR title + GitLab ticket ID if known
4. **Output contract**: "Return ONLY the structured findings block defined in your agent spec. No preamble. No summary."

For `util-reuse-agent`, the prompt must also include the candidate list with `path`, `line`, `name`, `intent`, `signature`, and `layer` for each new helper.

For `spec-conformance-agent`, the prompt must include the full `ticket_context` blob (title, description, labels, attachments) verbatim. Pass the diff as either inline hunks or a base branch — the agent reads changed files in full when it needs more context than the hunk gives. Do **not** filter the diff by layer; spec match spans the whole MR.

`dead-code-sweep` is a skill, not a registered subagent type — dispatch it via `subagent_type: general-purpose`, with a prompt that tells the agent to load and follow `.claude/skills/dead-code-sweep/SKILL.md` **in Review-only mode** (per that file's "Modes" section), passing it the same combined backend+frontend file scope and diff source as the other agents. The prompt must state explicitly: skip Scope Selection, do not delegate deletions, do not re-lint, do not commit or push — detection and findings only, in the same `[SEVERITY] path:line — problem` / `Fix:` format as the other agents.

## Step 4 — Aggregate

When all agents return:

1. Concatenate findings in this order: spec conformance → backend → frontend → util reuse → dead code
2. Within each section, sort by severity: BLOCKER → SUGGESTION → NITPICK
3. Dedupe identical `[SEVERITY] path:line — problem` lines (agents can overlap on edge cases — a backend "ad-hoc auth check" finding and a spec "behavior contradicts ticket" finding on the same line are *not* duplicates; keep both)
4. Collect all `Missing / Cannot Verify` items into a single section
5. If `spec-conformance-agent` returned "Skipped — no ticket body supplied", drop the empty section and note "Spec match: skipped (no ticket context)" in the Checklist Summary

## Step 5 — Impact analysis (always, produced by you)

> **Blast-radius shortcut:** if `graphify-out/graph.json` exists, use the `graphify-knowledge-graph` skill's Workflow A (caller surface, file-grouped) on each changed symbol to compute reach without grepping the repo. Workflow B (2-hop transitive callers) is the right tool when the diff renames or changes a signature.

Before the findings list, write **one paragraph** answering:

1. **What changed** — the minimum description of the behavioral change
2. **Blast radius** — which modules, endpoints, pages, or roles are affected. Call out anything touching **leaves, payroll, project_logs, or auth** (high-scrutiny surfaces) explicitly.
3. **Risk** — migrations, permission changes, serializer field changes (breaking for FE), cron/signal changes, anything that can silently change existing data

If blast radius or risk cannot be determined from the diff alone, say so and list the specific files you'd need to see.

## Step 6 — Final output (paste-ready for GitLab)

Load `refs/severity-rules.md` once if you need the exact output template. Produce:

```
## Impact
<2–4 sentences: what changed, blast radius, risk>

## Findings
<aggregated findings from all agents, sorted by severity>

## Missing / Cannot Verify
- <aggregated items from all agents>

## Checklist Summary
- Spec match: <n findings | skipped (no ticket context)>
- Backend: <n findings>
- Frontend: <n findings>
- Util reuse: <n findings>
- Dead code: <n findings>
```

If all agents returned "Clean", produce a single line:

```
Diff is clean — no findings across backend, frontend, util-reuse, dead-code, or spec-match checks.
```

If `spec-conformance-agent` was skipped (no `ticket_context`), word it as:

```
Diff is clean — no findings across backend, frontend, util-reuse, or dead-code checks. Spec match not verified (no ticket context).
```

## Do NOT

- Do NOT do the review yourself. Dispatch the agents. Your job is orchestration and aggregation.
- Do NOT read `.claude/rules/`, `best_practices.md`, `CODING_INSTRUCTIONS.md`, or the `refs/*.md` checklists unless you need the severity-rules output template. The agents handle the checklist work.
- Do NOT post to GitLab. The `mr-review-agent` owns posting and requires human approval first.
- Do NOT serialize agent dispatches. Parallel is the whole point of this architecture.
- Do NOT invent new severity labels or output formats. Stick to `refs/severity-rules.md`.
- Do NOT pad the output with praise, apologies, or hedging. Silence means pass.

## References (do not read unless needed)

- `refs/backend-checklist.md` — Django/SOLID/ORM checklist (backend agent loads this)
- `refs/frontend-checklist.md` — React/re-render/hooks checklist (frontend agent loads this)
- `refs/severity-rules.md` — severity labels, output format, voice rules (all agents load this)
- `.claude/agents/spec-conformance-agent.md` — diff vs. ticket agent (skipped without `ticket_context`)
- `.claude/skills/dead-code-sweep/SKILL.md` — dead code detection (dispatched in review-only mode; deletion/commit steps don't apply here)
- `.claude/rules/` — authoritative standards split by domain (agents load relevant files)
- `best_practices.md` — legacy entry point (references `.claude/rules/`)
- `CODING_INSTRUCTIONS.md` — legacy entry point (references `.claude/rules/`)
