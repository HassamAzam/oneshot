---
name: python-linting
description: Mandatory Python linting workflow (flake8 + pylint) and test naming conventions for this ERP repo. Used by backend-agent and qa-agent after every Python file change.
---

# Python Linting & Test Naming

Shared rules for all agents that write or modify `.py` files in this repo.

## Linting (mandatory after every Python file change)

Run both linters on **each changed `.py` file** before committing. Migrations are excluded automatically by both rc files.

```bash
# flake8 — config in .flake8 (excludes migrations/, max-line 120, inline-quotes=double)
flake8 <file1.py> <file2.py> ...

# pylint — config in .pylintrc (excludes migrations/, max-line 120)
pylint <file1.py> <file2.py> ...
```

**Key flake8 rules in effect** (not ignored):
- `D102` — public methods (including `setUpTestData`) must have docstrings
- `E501` / line length — max 120 chars
- `Q000` — double quotes required for inline strings (`inline-quotes = double`)

Fix all errors before reporting done. Zero errors from both tools is the bar.

## Comment style — hard rules

- **NEVER write inline comments.** No `# ...` lines, no trailing `  # ...` on a code line, no `# ----` section banners. Comments rot, restate the code, and clutter diffs.
- **Docstrings are the only allowed prose in source.** Module docstrings, function/method docstrings, and class docstrings are fine. Use them to explain *why* something exists or any non-obvious invariant.
- If you feel the urge to write an inline comment, choose one of these instead:
  1. Rename a variable / function so the code reads as the comment would have said.
  2. Extract a small named helper whose name carries the explanation.
  3. Add a sentence to the enclosing function's docstring.
- The only inline-comment exceptions allowed: `# type: ignore[...]` for genuine type-checker suppression and the lint-disable line below — both still require the affirmation rule.

## Imports — hard rules

- **All imports go at the top of the module.** No `from x import y` inside functions, methods, or branches.
- If a top-level import causes a circular dependency, do NOT silently move it inside the function with `# pylint: disable=import-outside-toplevel`. Instead, **stop and inform the user**: explain the circular chain (which two modules import each other), propose the structural fix (move the shared symbol to a third module, or split the import-heavy module), and proceed only after user affirmation. Falling back to a local import is acceptable only when the user explicitly approves it for that case.

## Lint-disable / noqa — hard rules

- **Disabling a linter rule is a code smell, not a fix.** `# pylint: disable=...`, `# noqa`, `# noqa: E501`, `# type: ignore`, and equivalents bypass the safety net the team has agreed to. The job is to write code the linter accepts, not to silence the linter.
- Common cases and the right fix:
  - **`E501` line-too-long** → break the line. For function signatures, put each parameter on its own line. For long strings, use implicit string concatenation across lines or a short helper variable. Do NOT add `# noqa: E501`.
  - **`broad-except`** → catch the specific exception type (or a tuple of types) the call site can actually raise. If a third-party SDK genuinely raises `Exception` and there is no narrower type, ask the user before disabling.
  - **`too-many-positional-arguments` / `too-many-locals`** → refactor: extract a dataclass/`TypedDict` for the parameter cluster, or split the function. Disable only with affirmation.
  - **`import-outside-toplevel`** → see the imports rule above.
- If you genuinely cannot avoid a disable (e.g. circular import that cannot be broken without large refactor; broad-except for a third-party SDK that raises bare `Exception`), **stop and inform the user** with: which file/line, which rule, why the alternatives fail, what the refactor would cost. Proceed only after explicit affirmation.
- When affirmed, place the disable on a single line, with the narrowest scope (one rule per disable, never blanket `# pylint: disable=all`), and add a one-line docstring/explanation in the enclosing function's docstring describing why.

## Test Naming (pylint C0103)

- Test method names must match `[a-z_][a-z0-9_]{2,50}$` — **max 50 characters** (enforced by pylint).
- Count characters before committing. If a descriptive name exceeds 50 chars, shorten it:
  - Drop filler words: `with`, `on`, `returns`, `the`, `that`
  - Use abbreviations: `ok` instead of `returns_200`, `empty` instead of `empty_string`
  - Example: `test_patch_with_null_comment_on_flagged_choice_returns_200` (58) → `test_patch_null_comment_flagged_choice_ok` (41) ✓
