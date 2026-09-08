---
name: planning-methodology
description: Feature planning methodology for this ERP repo — ticket analysis, reuse-first research, plan template, and approval workflow. Used by planner-agent to produce implementation plans before coding begins.
---

# Planning Methodology

## Input

One of:
- A Jira / GitLab ticket ID or URL
- A branch name that encodes the ticket (e.g. `hassam/SOP-1550_sophia-sync`)
- A raw problem description

If you get nothing, ask for one of these before doing anything else. Do not guess.

## Step 1 — Load the ticket

- **Jira key** → Atlassian MCP (`getJiraIssue`)
- **GitLab URL** → `WebFetch` (or GitLab MCP if wired)
- **Raw description** → take it verbatim, do not invent requirements

Capture title, acceptance criteria, linked parent. Missing AC → list as `[OPEN QUESTION]`, never invent them.

## Step 2 — Reuse-first research (small budget)

Use `Grep` / `Glob` / targeted `Read`. Do not exhaustively scan.

> **Graphify shortcuts:** if `graphify-out/graph.json` exists, the `graphify-knowledge-graph` skill gives you faster answers here than grep:
> - **Prior art search:** Workflow D (DRY cluster check) returns every helper Louvain-clustered with your intent keyword in one query.
> - **Affected surface:** Workflow A (caller surface, file-grouped) on the most-likely-touched function tells you which modules will be exposed before you write a line.

1. **Prior art** — is there an existing util, view, serializer, hook, or component that already does ≥ 60% of this? Cite `file:function`.
   - Backend: `common/**`, `apps/<app>/utils.py`, `apps/<app>/managers.py`
   - Frontend: `frontend/src/common/**`, `frontend/src/**/utils/**`, `frontend/src/**/hooks/**`
2. **Affected surface** — which apps / endpoints / containers / components are touched?
3. **Existing tests** — which test files already cover this surface? Extend them, don't fork.

Conditionally: migration check (schema changes), permission check (auth changes), integration check (Sophia / Odoo / Slack / etc).

Do NOT read `best_practices.md` or `CODING_INSTRUCTIONS.md`. Those are review concerns.

## Step 3 — Emit the plan

Use this exact structure. Keep it under ~100 lines.

```
# Plan — <ticket>: <one-line title>

## TL;DR
<2–3 sentences: what, why, where.>

## Ticket
- ID: <SOP-1234 / #4131 / branch>
- Type: feature | bug | refactor | migration | perf | chore
- Layer: backend | frontend | fullstack

## Acceptance Criteria
- [ ] ...
(Missing from ticket → [OPEN QUESTION]; do not invent.)

## Impact
- Blast radius: <apps / pages / roles>
- Data: <tables affected>
- API contract changes: <yes/no — fields>
- High-scrutiny surfaces: <leaves / payroll / project_logs / auth — or none>

## Reuse
- <file:function> — extend to handle <case>
- <file:function> — import instead of rewriting
(None → "No prior art found.")

## Phases

### Phase 1 — <name>
- Files: `path/to/a.py`, `path/to/b.jsx`
- Agent: `backend-agent` / `frontend-agent` (Sonnet)
- Tests: <files to add/extend>
- Exit: <how we know phase is done>

### Phase 2 — <name>
...

## Risks & Open Questions
- [RISK] <what could go wrong, with mitigation>
- [OPEN QUESTION] <needs developer / PM answer>

## Out of Scope
- <thing we're explicitly not doing>

## Rollout
- Feature flag / migration ordering / rollback (if relevant)
```

## Step 4 — STOP and ask

After emitting the plan, stop and ask literally:

```
Do you approve this plan?
- `yes` → hand off to implementation agents
- `revise: <notes>` → I'll update and re-emit
- `reject` → I'll start over with new inputs
```

I will NOT start implementation without an explicit "yes".

## Step 5 — Handle the response

- **yes** → Output: `Plan approved. Handing off to <next agent> for Phase 1.` Stop. You do not implement. The orchestrator / developer dispatches the dev agent.
- **revise: ...** → Update the called-out sections, re-emit the full plan, ask again.
- **reject** → Ask for new inputs. Do not reuse the old plan.

## Hard Rules

- Never start implementation.
- Never auto-proceed. Every plan pauses for confirmation, every time.
- Never invent acceptance criteria.
- Never skip the reuse hunt.
- Keep plans under ~100 lines. If bigger, your phases are too big — split them.
- No hedging. Say what should happen and why.
