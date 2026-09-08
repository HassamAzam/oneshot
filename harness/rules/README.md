# Rules

Authoritative coding standards for this ERP project, split by domain.

| File | Scope |
|------|-------|
| `branching.md` | Base/target branch selection by discovery environment, promotion & back-merge flow |
| `frontend-structure.md` | Container/component split, file limits, util extraction |
| `frontend-style.md` | Imports, inline styles, schemas, PropTypes, keys |
| `frontend-performance.md` | Waterfalls, memoization, lazy loading, virtualization |
| `backend-django.md` | Views, serializers, models, queries, migrations |
| `backend-python.md` | Pylint standards, naming, error handling, logging |
| `solid.md` | SOLID principles applied to Django + React |
| `security.md` | Secrets, input validation, permissions, XSS |
| `testing.md` | Coverage expectations, test organization |

These files replace the former monolithic `best_practices.md` and `CODING_INSTRUCTIONS.md`.
Both legacy files remain at the repo root for backward compatibility but point here.
