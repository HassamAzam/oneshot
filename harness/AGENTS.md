# AGENTS.md

Cross-tool rules for AI coding assistants in this repo. Works for **Claude Code**, **Cursor**, **GitHub Copilot**, **Google Antigravity**, **Codex**, **Aider**, and anything else that reads `AGENTS.md` or its equivalent.

This file is intentionally thin. Authoritative standards live elsewhere; read them when you need depth:

- [`CLAUDE.md`](CLAUDE.md) — project overview, architecture, container/component split, hard rules (full detail)
- [`.claude/rules/`](.claude/rules/) — authoritative coding standards, split by domain (SOLID, Django, React, security, testing)
- [`best_practices.md`](best_practices.md) / [`CODING_INSTRUCTIONS.md`](CODING_INSTRUCTIONS.md) — legacy entry points that reference `.claude/rules/`
- [`.github/copilot-instructions.md`](.github/copilot-instructions.md) — Copilot-specific guidance
- [`.pr_agent.toml`](.pr_agent.toml) — Qodo Merge review emphasis (treat as reference)
- [`.gitlab/merge_request_templates/default.md`](.gitlab/merge_request_templates/default.md) — MR template

---

## Project

Django (backend) + React (frontend) ERP.

- Backend: Django 4.x + DRF, Python 3.12, Celery, PostgreSQL 14
- Frontend: React 18.3 + Redux + MUI v6
- 34+ Django apps under `apps/`, shared utilities in `common/`
- Frontend modules under `frontend/src/components/<module>/{components,containers,utils,styles,formValidations.js}`

---

## Workflow: Plan → Implement → Review

Every non-trivial change follows this loop. Each phase has a clear handoff.

### 1. Plan (before writing code)

1. Load the ticket (Jira / GitLab / branch slug). If there is no ticket, stop and ask for one.
2. Run a **reuse-first scan**: is there an existing util, view, serializer, hook, or component that already does ≥ 60% of the work? Cite `file:function` if found.
3. Identify affected surface: apps, endpoints, containers, components, tests.
4. Produce a short phased plan (TL;DR, acceptance criteria, impact, phases with files-to-touch, risks, rollout, test strategy).
5. **Stop and wait for explicit developer approval** before writing any code. Never auto-proceed.

Claude Code implementation: [`.claude/agents/planner-agent.md`](.claude/agents/planner-agent.md) (runs on Opus).

For Copilot / Antigravity / other tools that don't support multi-agent orchestration: produce the plan inline as a markdown block, paste it back to the developer, and wait for `yes` / `revise` / `reject` before editing files.

### 2. Implement

Only after the plan is approved.

- **Backend SRP + util reuse**: keep views readable and endpoint-focused; extract shared logic to `utils/`, managers, or model methods. Do not add a service layer by default.
- **Container / component split**: containers own state + API calls + side effects; components are presentational only.
- **File limits**: files ≤ 200 lines, functions ≤ 50 lines (ESLint enforced on FE).
- **No inline styles or inline Yup schemas** — see hard rules below.
- **DRY**: extend existing utils before writing new ones. Never copy-paste.
- **Tests first** when the change has non-trivial logic — unit, integration, and (for user-facing) E2E.

Claude Code: `backend-agent`, `frontend-agent`, `qa-agent` (all Sonnet).

### 3. Review (before opening the MR)

1. Run the layered code review on the diff:
   - **Backend review** — SOLID, ORM performance (`select_related` / `prefetch_related`), thin-view discipline, serializer hygiene, permissions, migrations, backend security
   - **Frontend review** — re-render bugs, hooks correctness, container/component split, inline styles, request waterfalls, list keys, storage reads, FE security
   - **Util reuse sweep** — search `common/`, `apps/*/utils.py`, `frontend/src/common/`, `frontend/src/**/utils/` for duplicate helpers
2. Output findings with severity labels: `[BLOCKER]` / `[SUGGESTION]` / `[NITPICK]`, each paired with a **concrete fix** — not "refactor this".
3. After human approval, post inline comments + one MR-level comment to GitLab via the GitLab MCP.

Claude Code: `erp-code-review` skill → `backend-reviewer-agent`, `frontend-reviewer-agent`, `util-reuse-agent`; posting via `mr-review-agent` + GitLab MCP (all Sonnet).

For Copilot / Antigravity: invoke the review workflow inline against the current diff and return the same severity-labelled output. The developer pastes approved findings into GitLab.

---

## MR / Branch Conventions

- **Branch**: `<author>/<slug-with-context>`
  - examples: `ibrahim/leaves-approver`, `kno/feat/SOP-1550_update-sophia-sync`, `hassam/qa-issues`
- **GitLab ticket is mandatory** — reference it in the branch slug AND in the MR title or description. Missing ticket → **BLOCKER**, do not open the MR.
- **Target**: usually `dev`. `stage` or `master` only for ad-hoc releases.
- **MR template**: follow `.gitlab/merge_request_templates/default.md` — fill Related Issue, Description, What has Changed, Checklist. Empty sections → **BLOCKER**.
- **Size**: keep MRs under 400 LOC changed. Split unrelated themes into separate MRs.

---

## Hard Rules (cheap checks, always on)

These are always applied, in every AI tool, on every change:

- **No hardcoded secrets** — env vars only. API keys, tokens, DB URLs, webhooks — never inline.
- **No `console.log`** in committed JS — `console.error` / `console.warn` only when justified.
- **No inline `sx` / `style` props** — centralize in `styles/<module>Styles.js` (see `.claude/rules/frontend-style.md`). Exception: truly dynamic values like `sx={{ width: \`${progress}%\` }}`.
- **No inline Yup / Formik schemas** — extract to `formValidations.js`.
- **No wildcard icon / UI imports** — `import { X } from 'lucide-react'`, never `import *`.
- **PropTypes required** on every new React component.
- **Max file length**: 200 lines. **Max function length**: 50 lines.
- **Django**: follow SRP, keep views maintainable, reuse `utils/` and model methods for shared logic, and always use `select_related` / `prefetch_related` for FK / M2M access in loops.
- **Pylint-friendly Python**: clear naming, no unused imports, no dead code, and no broad exceptions without logging or context.
- **Migrations are mandatory** whenever models, fields, relations, constraints, or schema change.
- **No `print()`** in Python — use the `logging` module.
- **No bare `except Exception: pass`** — handle or re-raise with context.
- **No N+1 queries** in serializers or list endpoints.
- **High-scrutiny surfaces**: escalate immediately if a change touches `apps/auth/`, payments, `common/permissions.py`, leaves, payroll, or project_logs.

---

## Commit Messages

```
<type>: <short description> (#<ticket>)
```

- Types: `feat`, `fix`, `chore`, `refactor`, `test`, `perf`, `ci`, `docs`
- Ticket reference is mandatory
- Examples: `feat: add invoice filter (#88)`, `fix: show only active people to approver in leaves summary dropdown (SOP-1231)`

---

## Ask Before You Add

- Do not add new conventions here. If a pattern is worth enforcing, add it to the appropriate file in `.claude/rules/` and reference it from this file.
- Do not duplicate standards into tool-specific configs (`.cursor/rules/`, `.github/copilot-instructions.md`). Point to `.claude/rules/`.
- If a rule feels missing, surface it as a discussion point, not a finding.

---

## Tool-Specific Extensions

Each AI tool has its own richer configuration layered on top of this file. They all implement the same workflow and rules; they differ only in *how* the agents are wired.

| Tool | Entry point | Extras |
|---|---|---|
| **Claude Code** | [`CLAUDE.md`](CLAUDE.md) | `.claude/agents/`, `.claude/skills/erp-code-review/`, `.claude/commands/erp-review.md`, `.claude/commands/erp-review-mr.md` |
| **Cursor** | `.cursor/rules/*.mdc` | auto-attach glob rules for `apps/**` and `frontend/**` |
| **GitHub Copilot** | [`.github/copilot-instructions.md`](.github/copilot-instructions.md) | long-form coding standards (loaded as system prompt) |
| **Google Antigravity** | `AGENTS.md` (this file) | reads this file directly |
| **Codex / Aider / others** | `AGENTS.md` (this file) | reads this file directly |

If you're using a tool not listed here, this file is your primary source of truth — `CLAUDE.md` and `.claude/rules/` are the deeper references.
