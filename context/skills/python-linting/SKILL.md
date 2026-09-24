---
name: python-linting
description: Judgement calls around Python linting in this ERP repo — what to do instead of an inline comment, when a lint disable is legitimate, how to break a circular import, and how to shorten an over-long test name. The flake8/pylint run and the inline-comment ban are enforced by the py-lint hook, not by this skill.
---

# Python Linting & Test Naming

Shared rules for all agents that write or modify `.py` files in this repo.

## What the hook already does

`hooks/py-lint.cjs` runs flake8, pylint and an inline-comment scan on every
`.py` file a phase writes, and blocks the write when any of them has something
to say. You do not need to run the linters yourself, and there is no value in
reporting that you did — a clean write means the gate passed.

What the hook cannot do is choose the fix. Everything below is that choice.

## Instead of an inline comment

The hook rejects `#` comments, so the question is never *how to word one*. It is
which of these the comment was trying to compensate for:

1. A variable or function whose name does not say what it holds — rename it so
   the code reads as the comment would have.
2. A block doing something the surrounding function does not explain — extract
   it into a small helper whose name carries the explanation.
3. A genuinely non-obvious invariant or reason — add a sentence to the
   enclosing function's docstring.

Docstrings are the only prose allowed in source: module, class, function and
method. Use them for *why*, not for restating *what*.

## Circular imports

All imports go at the top of the module. When a top-level import creates a
cycle, moving it inside the function is not the fix — it hides a structural
problem behind a disable and the cycle survives.

**Stop and tell the user.** Name the two modules that import each other, propose
the structural fix (move the shared symbol to a third module, or split the
import-heavy one), and say what it would cost. A local import is acceptable only
when the user explicitly approves it for that case.

## When a lint disable is legitimate

Disabling a rule is a code smell, not a fix — the job is code the linter
accepts. Reach for the real fix first:

| Rule | The fix that is not a disable |
| --- | --- |
| `E501` line-too-long | Break the line. One parameter per line for signatures; implicit concatenation or a short named variable for long strings. |
| `broad-except` | Catch the exception the call site can actually raise. |
| `too-many-positional-arguments` / `too-many-locals` | Extract a dataclass or `TypedDict` for the parameter cluster, or split the function. |
| `import-outside-toplevel` | See circular imports above. |

Two cases are genuinely irreducible: a cycle that cannot be broken without a
large refactor, and a third-party SDK that raises bare `Exception`. For those,
**stop and inform the user** — file and line, the rule, why each alternative
fails, what the refactor would cost — and proceed only on explicit affirmation.

When affirmed: one rule per disable, narrowest possible scope, never a blanket
`# pylint: disable=all`, and a line in the enclosing docstring saying why. The
hook allows `# pylint:` and `# noqa` comments through precisely so this path
stays open — it cannot tell an affirmed disable from an unaffirmed one, so that
honesty is yours to keep.

## Test naming (pylint C0103)

Test method names must match `[a-z_][a-z0-9_]{2,50}$` — **max 50 characters**.
Pylint enforces the limit; shortening without losing the meaning is the part it
cannot do:

- Drop filler: `with`, `on`, `returns`, `the`, `that`.
- Abbreviate outcomes: `ok` for `returns_200`, `empty` for `empty_string`.
- Keep the subject and the condition; those are what a failure report is read
  for.

`test_patch_with_null_comment_on_flagged_choice_returns_200` (58) →
`test_patch_null_comment_flagged_choice_ok` (41) ✓
