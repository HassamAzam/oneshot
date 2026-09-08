# SOLID Principles

Applied to this Django + React codebase.

## S — Single Responsibility

- One reason to change per class, function, component.
- React: container XOR presentation — never both.
- Django: views handle request flow; serializers handle shape; utils handle shared logic.
- If a function validates, persists, notifies, AND formats — split it.

## O — Open / Closed

- Open for extension, closed for modification.
- Prefer strategy maps, mixins, and decorators over growing if/elif chains.

```python
# BAD
if user_type == "premium": ...
elif user_type == "vip": ...

# GOOD
STRATEGIES = {"premium": ..., "vip": ...}
strategy = STRATEGIES.get(user_type, default)
```

## L — Liskov Substitution

- Subclass methods honor the parent contract (same params, compatible returns).
- Django: overriding `save()` / `clean()` / `delete()` must call `super()` unless explicitly documented otherwise.

## I — Interface Segregation

- Components accept only the props they use — not entire objects for one field.
- Serializers include only fields relevant to the endpoint (list vs detail).
- API payloads stay lean.

## D — Dependency Inversion

- Centralize API access in utils or module-level helpers — do not scatter raw `fetch()` / `axios` calls.
- Extract reusable ORM logic to utils, model methods, or custom managers.
- Config values (URLs, feature flags) from env/config, not hardcoded.
