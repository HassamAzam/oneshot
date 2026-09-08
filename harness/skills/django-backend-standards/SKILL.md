---
name: django-backend-standards
description: Django coding rules for this ERP repo — views, serializers, managers, settings config. Used by backend-agent when building models, views, serializers, and APIs. For migration rules, see the django-migration-standards skill.
---

# Django Backend Standards

## Coding Rules

- Business logic lives in views (and `utils/` for reusable helpers) — not in a separate `services.py`
- Serializers in `serializers.py`, never inline
- Class-based views (ViewSets) for CRUD, function-based for simple endpoints
- `snake_case` for everything Python
- Max 120 characters per line — applies to all code, docstrings, and comments. Wrap at 120; never exceed it.
- Cognitive complexity of every function must stay below 15. Count nesting penalties: each control structure (`for`, `if`, `while`) adds +1, plus +1 per nesting level it sits in. If a function exceeds 15, extract helpers to flatten nesting.
- Meaningful variable names always — single or two-character names (e.g. `r`, `qs`, `pk`, `fn`) are not allowed. Lambda parameters must also be descriptive (e.g. `lambda record:` not `lambda r:`)
- Type hints on all new functions
- Docstrings on models and services

## ORM & Query Optimization

Read and follow the **`code-optimization`** skill for all ORM and query performance rules (N+1 prevention, `select_related`/`prefetch_related`, bulk ops, `.exists()`, `.count()`, indexing, etc.).

## Manager Selection — Active Objects Manager (checklist item)

Most models in this repo are soft-deleted via an `is_active` flag and declare two managers:

```python
active_objects = ActiveObjectsManager()
objects = models.Manager()
```

- **Before writing any query, check the model's manager declarations.** If the model has `active_objects`, that is the default choice for every read in app code (views, serializers, utils, management commands, Celery tasks). Plain `.objects` on such a model silently includes soft-deleted rows — reviewers will flag it (typical MR comment: "`.active_objects`?").
- Use plain `.objects` on a soft-deletable model **only when you deliberately need inactive rows**, e.g. duplicate/idempotency guards where a soft-deleted row must still block re-creation, `get_or_create` lookups that must not create a duplicate of an inactive row, or admin/audit views. When you do, say why in the function's docstring.
- Writes (`create`, `bulk_create`, `update`) can use `.objects`; the manager only matters for what a queryset *reads*.
- Data migrations are the exception: always `_base_manager` there (see the `django-migration-standards` skill) — `active_objects` doesn't exist on historical models.

## Settings Configuration

- `/etc/hrdb/settings.ini` is the runtime config file consumed by `hrdb/local_settings.py`. **`local_settings.py` is gitignored.**
- Whenever you add a new `[section]` to `settings.ini` (or a new key under an existing section), you **must** also declare a baseline default for the same setting in `hrdb/config.py`. `config.py` is tracked in git.
- Place the defaults BEFORE the `from .local_settings import *` line at the bottom of `config.py`, so local_settings can override them. Group related settings under a `# === Section Name ===` header matching the others.
- Use safe baselines: `""` for URLs / API keys, `False` for boolean toggles, sensible neutral values for models / numbers. The point is that production must boot with these defaults even when ops hasn't refreshed local_settings.py yet.
- Example for an `[audit_llm]` section:
  ```python
  # ======================================================================================================================
  # Audit LLM Configuration
  # ======================================================================================================================
  AUDIT_LLM_URL = ""
  AUDIT_LLM_API_KEY = ""
  AUDIT_LLM_MODEL = ""
  AUDIT_LLM_ENABLED = False
  ```
- Why: any code that does `settings.NEW_SETTING` will raise `AttributeError` at runtime if a deploy lands without an updated local_settings.py. Declaring the default in `config.py` is the deploy-safety net. Defensive `getattr(settings, "X", "")` at call sites is fine, but **not a substitute** for the framework-level default.

## Migrations

Read and follow the **`django-migration-standards`** skill for all migration rules — one-migration-per-task consolidation (with HITL merge proposals), schema/data separation, `_base_manager` and other data-migration patterns, `max_migration.txt` discipline, crash-safety logging, reversibility, and the mandatory verification protocol.
