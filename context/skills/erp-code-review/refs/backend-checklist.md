# Backend Review Checklist

Authoritative: `.claude/rules/solid.md` and `.claude/rules/backend-django.md`. This file is a checklist, not a rulebook — read the spec when you need depth.

## Universal (every backend diff)

- [ ] No hardcoded secrets, API keys, tokens, DB URLs
- [ ] No `print()` — use the `logging` module
- [ ] No commented-out code
- [ ] No magic numbers — extract to module-level constants
- [ ] No bare `except Exception: pass` — handle or re-raise with context
- [ ] Error messages do not leak internal IDs, stack traces, or PII to clients

## Thin views discipline

- [ ] Views delegate to `utils/`, helpers, or services (team preference: views + utils)
- [ ] View method stays roughly < 40 lines
- [ ] No business logic in serializer `.create()` / `.update()` beyond orchestrating
- [ ] DRF serializer handles validation and shape; view does not duplicate validation
- [ ] `get_object_or_404` instead of manual `try: .get() except DoesNotExist`
- [ ] Query params validated via the project's `ParamValidator` pattern (`apps/<app>/api/v1/param_validations/*.py`, subclass of `common.utils.ValidationSerializer`) — **not** manual `request.query_params.get()` + `int()` / `try: ... except ValueError`. **BLOCKER** when a new view skips it; reuse an existing validator if the field set matches.

## Integration boundaries

- [ ] No env vars in this diff that are namespaced for an external system (e.g. `RRP_AI_*`, `<PARTNER>_API_KEY`, `<VENDOR>_PROVIDER_URL`). If found → **BLOCKER**, the integration is inverted: ERP should expose raw data and let the partner system make the third-party call itself.
- [ ] No `requests.post` / OpenAI / LiteLLM / third-party HTTP call where the credentials and use-case belong to a partner system. ERP only calls third-party APIs when ERP itself owns the use-case (e.g. existing LibreChat integration for log validation).

## SOLID (apply with judgement)

### S — Single Responsibility
- A view / class / function doing more than one of {validate, persist, notify, format, orchestrate} → **[SUGGESTION]** split
- Serializer doing validation AND side effects (sending emails, writing to other models) → move side effects to a service or signal

### O — Open/Closed
- `if user_type == X / elif Y / elif Z` chains that grow with each new type → **[SUGGESTION]** map / strategy pattern (see `.claude/rules/solid.md`)
- Modifying a shared base function to special-case one caller → extend via override / mixin / composition

### L — Liskov Substitution
- Subclass overrides a method but raises exceptions the parent doesn't declare, or returns an incompatible shape → **[BLOCKER]** if it can break existing callers; otherwise **[SUGGESTION]**
- Overridden Django `save` / `clean` / `delete` that doesn't call `super()` without a documented reason → **[SUGGESTION]**

### I — Interface Segregation
- DRF serializer includes fields the endpoint doesn't need (list endpoint returning full detail payload) → **[SUGGESTION]** split into list/detail serializers
- API response returns nested data the client doesn't consume → lean it out

### D — Dependency Inversion
- View embedding raw SQL or complex ORM chains that belong in a manager / queryset → **[SUGGESTION]**
- Hardcoded URLs, feature flags, env-specific values inline → **[BLOCKER]** if it's a secret, **[SUGGESTION]** otherwise

### When NOT to flag SOLID
- 10-line utility function — overkill
- Throwaway test helper
- Existing code touched only tangentially by the MR (out of scope)

## ORM performance

- [ ] `select_related` used for FKs / OneToOne walked inside loops or any repeated logic
- [ ] `prefetch_related` used for reverse FKs and M2Ms walked in loops or any repeated logic
- [ ] `.only()` / `.defer()` on hot paths where the full model isn't needed
- [ ] `bulk_create` / `bulk_update` instead of loop-save
- [ ] No `.all()` followed by Python-side filtering that the DB could do
- [ ] `.exists()` instead of `len(qs) > 0` or `if qs:`
- [ ] `.count()` instead of `len(qs)` when rows aren't needed
- [ ] Filterable fields have `db_index=True` on the model
- [ ] No N+1 / heavy per-object work — missing `select_related`/`prefetch_related`, a `SerializerMethodField` or property hitting the DB per row, or global data re-fetched per object instead of passed via context. **Read `.claude/skills/django-query-optimisation/SKILL.md` for the red-flags, examples, and fixes** (bulk-lookup map, context passing, `annotate`, `Prefetch`) and cite it in the `Fix:` line. SUGGESTION; BLOCKER on a hot list endpoint.

## Code Quality & Documentation

- [ ] Function names accurately reflect their behavior
- [ ] Docstrings match the function's actual logic, parameters, and return values

## Models / Migrations

- [ ] `__str__` defined on new models
- [ ] `Meta.ordering` only if a stable default sort is actually needed (it's not free)
- [ ] Migration is backwards-compatible with currently deployed code (no rename-and-use in same MR)
- [ ] No `NOT NULL` without a default on a populated table
- [ ] `RunPython` has a `reverse_code`, or `dummy_reverse` with a documented reason (see `django-migration-standards`)
- [ ] Index creation on large tables uses `AddIndexConcurrently` where the DB supports it
- [ ] No table-locking operation on a large table without a plan — confirm with the author
- [ ] No 2+ new migration files for the same app in this diff without a documented HITL-exception reason in the docstrings (they should have been merged into one — see `django-migration-standards`)

## Security

- [ ] No hardcoded secrets, API keys, tokens
- [ ] No raw SQL with f-string / % formatting on user input — use parameterized queries
- [ ] User input never reaches `.extra()` or `.raw()` unsanitized
- [ ] Permission classes used — no ad-hoc auth checks inside view logic
- [ ] State-changing endpoints have CSRF / authentication
- [ ] Sensitive fields (passwords, tokens, internal IDs, PII) never appear in response serializers
- [ ] Error responses don't leak stack traces or internal state to unauthenticated users

## Tests (when touching tested modules)

- [ ] New business logic has a unit test
- [ ] New endpoint has an API / integration test
- [ ] Edge cases and error paths covered — not just the happy path
- [ ] No `time.sleep` / flaky waits
- [ ] `factory_boy` factories used over raw fixtures for new test data
- [ ] No real external API calls — mock or use VCR
