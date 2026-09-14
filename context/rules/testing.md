# Testing Rules

## Coverage

- All new business logic must include unit tests.
- All new API endpoints must include integration tests.
- Test edge cases and error scenarios — not just the happy path.

## Organization

- Keep test files close to the code they test.
- Descriptive test names that explain the scenario.
- Use `factory_boy` for test data — not raw fixtures.

## Django

- `pytest` as the runner.
- Use `APIClient` for endpoint tests.
- Assert status codes, response shapes, and side effects.
- Migration correctness is exempt from this flow — `hrdb/test_settings.py` builds the test DB straight from `models.py` and never executes a migration file, so `manage.py test` proves nothing about a migration. Migration verification is governed separately by the `django-migration-standards` skill.

## Frontend

- Jest for unit tests.
- Test utilities, data transforms, and custom hooks directly.
- For visual components, prefer screenshot / visual regression over brittle DOM assertions.
