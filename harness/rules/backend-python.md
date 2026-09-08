# Backend — Python Standards

## Naming

- `snake_case` for variables, functions, model fields.
- `PascalCase` for classes.
- Descriptive, intention-revealing names — avoid single-letter or unexplained abbreviations.

## Pylint-Friendly Code

- No unused imports or variables.
- No dead code or commented-out blocks.
- No duplicated branches.
- Prefer small functions with early returns over deep nesting.

## Comments

- **Never write inline `#` comments** while writing code — neither inside function bodies nor at module level. Well-named identifiers and small, focused functions are the explanation.
- If a function, method, or class genuinely needs explanation, put it in a **short docstring** instead.
- No commented-out code (already enforced above).
- Do not reference the current ticket, MR, fix, or callers in code — that context belongs in the MR description and rots in the codebase.

## Error Handling

- No `print()` — use the `logging` module.
- No bare `except Exception: pass` — handle, log context, or re-raise.
- Avoid overly broad `except Exception` unless it logs and re-raises or returns a deliberate fallback.
- Error messages to clients must not leak internal IDs, stack traces, or PII.

## Logging — Which Logger and Which Level

Only two logger names are acceptable for new code: `"hrdb"` or `__name__`. Subsystem names (`"costing"`, `"sophia"`, `"odoo"`) are reserved for code inside those subsystems.

**Why it matters:** `hrdb/settings.py` `LOGGING` config sets the root logger to ERROR with `disable_existing_loggers: True`. A logger created with `getLogger(__name__)` falls back to root, so its INFO and WARNING records are silently dropped in prod. The `"hrdb"` logger is configured at INFO and writes to a dedicated `hrdblog` rotating file — it is the only general-purpose channel that preserves INFO/WARNING.

| Log level | Use | Reason |
|---|---|---|
| INFO (operational events worth preserving — migration ran, task completed, sync started) | `logging.getLogger("hrdb")` | INFO+ is captured in `hrdblog` |
| WARNING (anomaly that does not fail — drift detected, fallback used, record skipped) | `logging.getLogger("hrdb")` | Must be visible |
| ERROR (failed operation, recoverable) | `logging.getLogger(__name__)` | ERROR propagates to root → SysLog/console/logfile |
| `logger.exception(...)` inside `except:` | `logging.getLogger(__name__)` | Same as ERROR + traceback |
| DEBUG (development only) | `logging.getLogger(__name__)` | Filtered out in prod |

**Never** invent a custom logger name like `getLogger("migrations.foo")` or `getLogger("my.module")` — there is no matching loggers config, so it inherits root (ERROR) and silently drops INFO/WARNING. If a non-ERROR message must be readable in prod logs after the fact, use `getLogger("hrdb")`.

## Type Hints & Docstrings

- Type hints on all new functions.
- Docstrings on non-trivial models and helpers.

## DRY

- Check `common/` and app-level `utils.py` before writing new helpers.
- Shared queryset helpers, formatting, and calculations belong in `utils.py` or `common/`.
- No copy-paste between endpoints — centralize repeatable logic.
