# Backend — Django Rules

## View Discipline

- Views handle request flow: parse input, call helpers, return response.
- Keep views readable and scoped to the endpoint. Do not pack validation + persistence + notification + formatting into one method.
- When logic is shared across endpoints, extract to `utils.py`, model methods, managers, or query helpers.
- Do **not** create `services.py` by default. Avoid thin pass-through wrappers.
- Use `get_object_or_404()` — no manual `try: .get() except DoesNotExist`.
- Use class-based ViewSets for CRUD, function-based views for simple endpoints.
- Validate query params via the project's `ParamValidator` pattern (`apps/<app>/api/v1/param_validations/*.py`, subclass of `common.utils.ValidationSerializer`). No manual `request.query_params.get()` + `int()` / `try: ... except ValueError`. Reuse an existing validator if its field set matches; add a sibling validator alongside the others when it doesn't.

## Integration Boundaries

- Credentials, model selection, and provider URLs that semantically belong to an external system stay on that system's side. ERP does not act as a proxy for another service's third-party API calls.
- Heuristic: if a new env var is namespaced for an external system (e.g. `RRP_AI_*`, `<PARTNER>_API_KEY`, `<VENDOR>_PROVIDER_URL`), the integration boundary is wrong. Expose the raw data ERP owns; let the partner system fetch it and make the third-party call itself.
- Exception: ERP may call a third-party service when ERP itself owns the use-case (e.g. our own LibreChat / OpenAI integration for log validation). The test is "whose problem is the LLM result for?" — if it's the partner's, the partner calls the LLM.

## Query Optimization

- **Use `Model.active_objects` for reads on soft-deletable models.** If a model declares `active_objects = ActiveObjectsManager()`, plain `.objects` reads silently include `is_active=False` rows. Default every read (views, serializers, utils, commands, tasks) to `active_objects`; use `.objects` only when inactive rows are deliberately needed (idempotency/duplicate guards, `get_or_create`, audit views) and state why in the docstring. Data migrations use `_base_manager` instead.
- `select_related()` for ForeignKey / OneToOne. `prefetch_related()` for M2M / reverse FK.
- Missing `select_related` or `prefetch_related`: Check for any FK, OneToOne, reverse FK, or M2M traversal in loops, properties, or any repeated logic.
- `bulk_create()` / `bulk_update()` for batch operations — never loop-save.
- `.only()` / `.defer()` on hot paths when full model data is not needed.
- No N+1 queries anywhere (endpoints, loops, tasks, properties, serializers). Heavy calculations or DB fetches must be optimized (e.g., passing data in context or bulk lookup maps instead of fetching per item).

## Serializers

- Serializers handle validation and representation only — no side effects (emails, writes to other models).
- Separate serializers for list / detail / create / update when field sets differ.
- Use `read_only_fields` and `write_only_fields`. Never expose passwords, tokens, or internal IDs.
- Do not duplicate validation that belongs in model `clean()` or standalone validators.

## Docstrings & Naming

- Function names and docstrings must accurately match the implemented behavior.
- Ensure parameter descriptions and return value documentation are kept up-to-date with any changes.

## Models

- Every model needs `__str__()`.
- Prefer database-level constraints (`unique_together`, `CheckConstraint`) over app-only validation.
- `db_index=True` on fields used in frequent filters and lookups.
- Define `Meta.ordering` only when necessary — avoid implicit ordering on large tables.

## Migrations

- **Mandatory**: any model, field, constraint, relation, or schema change must include the migration in the same MR.
- Data backfills use a data migration — not manual scripts or ad-hoc management commands.
- Watch for: NOT NULL without default on populated tables, irreversible `RunPython`, rename-and-use in the same MR, index on large tables without `AddIndexConcurrently`.
- For file-consolidation (one migration per task, not one per plan step), reversibility, and the mandatory verification protocol, read the **`django-migration-standards`** skill — it is the authoritative source for all migration file practices in this repo.

## Celery Tasks

- Tasks must be idempotent.
- Use `logging`, not `print()`.
- Do not import models at module level inside task files if it causes circular imports — import inside the function.
