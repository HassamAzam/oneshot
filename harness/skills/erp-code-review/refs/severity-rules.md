# Severity Rules & Output Format

Shared by all ERP code review agents (`backend-reviewer-agent`, `frontend-reviewer-agent`, `util-reuse-agent`, `spec-conformance-agent`) and the `erp-code-review` skill orchestrator.

## Severity labels

| Label | Use for |
|---|---|
| **BLOCKER** | Security (auth, PII leak, injection, secrets, XSS), data loss, migration that breaks prod, missing GitLab ticket, broken build/tests, LSP violations that break existing callers, **missing must-have ticket requirement, behavior that contradicts the ticket, ticket-named edge case unhandled, ticket-named tests missing, scope creep into auth / payroll / migrations / shared utils** |
| **SUGGESTION** | SOLID violations, performance anti-patterns (missing `select_related`, N+1 anywhere, heavy calculation in repeated logic/serializers, re-render bugs, cascading `useEffect`, request waterfalls), missing tests for new logic, DRY / util duplication, inline styles / schemas, thin view violations, misleading docstrings/function names, **scope creep (unrelated changes not in the ticket), UI copy mismatch on non-compliance surfaces, partial implementation of nice-to-have ticket items** |
| **NITPICK** | Naming, import order, minor readability, docstring / JSDoc gaps, misplaced util scope without a duplicate, **minor wording / label mismatch with the ticket mockup** |

**Hard rule**: Security, auth, or data-loss issues are **always BLOCKER**, regardless of how small they look.
**Hard rule**: Missing must-have ticket requirements and contradicted ticket behavior are **always BLOCKER** — the diff is not the ticket the author claimed to implement.

## Finding format (strict, one per finding)

```
[SEVERITY] <path>:<line> — <one-line problem>
  Fix: <concrete suggestion>. See <spec>.
```

- `<path>` is relative to repo root
- `<line>` is the post-change line number
- `<one-line problem>` names the rule violated (e.g. "SRP", "missing select_related", "re-render: new object literal prop")
- `Fix:` is always present and always concrete. "Refactor this" is not a fix.
- `See <spec>` is a link like `.claude/rules/solid.md` or `.claude/rules/frontend-style.md` where applicable. Optional if the finding is self-evident.

## Aggregated review output (produced by the skill)

```
## Impact
<2–4 sentences: what changed, blast radius, risk>

## Findings
[BLOCKER] <path>:<line> — <problem>
  Fix: <concrete suggestion>

[SUGGESTION] <path>:<line> — <problem>
  Fix: <concrete suggestion>

[NITPICK] <path>:<line> — <problem>
  Fix: <concrete suggestion>

## Missing / Cannot Verify
- <things that couldn't be checked from the diff alone>

## Checklist Summary
- Spec match: <n findings | skipped (no ticket context)>
- Backend: <n findings>
- Frontend: <n findings>
- Util reuse: <n findings>
- Migrations: <n findings>
- Tests: <n findings>
```

## Review voice (strict)

- **Direct, terse, no fluff.** No "Great work, just a few small suggestions".
- **One finding per item** — no compound "also, also, also".
- **Always pair a problem with a concrete fix.** Never "this should be improved".
- **Silence means pass.** Do not list checklist items that passed.
- **If the diff is clean, say so in one line and stop.**
- No praise padding. No apology padding. No hedging.

## Do NOT

- Do NOT post comments directly to GitLab. The skill produces the review for human approval first; posting happens only through `mr-review-agent` + `mcp__gitlab` after the user approves.
- Do NOT suggest adding `try/except` / `try/catch` unless there is a real error-handling gap (per `.pr_agent.toml` item 14).
- Do NOT restate `.claude/rules/` content — link to the file and show the fix.
- Do NOT invent rules not in `.claude/rules/`. Call new-rule ideas out as a discussion point, not a finding.
- Do NOT flag style rules that ESLint / Prettier / Stylelint / pylint / ruff / flake8 already catch — trust CI.
