# Security Rules

## Secrets

- No hardcoded API keys, tokens, passwords, DB URLs, or webhook URLs in source code.
- Use environment variables or a secrets manager.

## Input Validation

- Validate and sanitize all user inputs.
- Use DRF serializers for API input validation — do not trust raw `request.data`.
- No raw SQL with string interpolation — use parameterized queries or ORM.
- No unvalidated user input reaching `.extra()` or `.raw()`.

## Permissions

- Use Django/DRF permission classes — no ad-hoc auth checks inside view bodies.
- CSRF protection on all state-changing endpoints.

## API Responses

- Never expose passwords, tokens, internal IDs, or PII in responses.
- Error messages must not leak stack traces or internal details to clients.

## Frontend

- No `dangerouslySetInnerHTML` without sanitization.
- No user input interpolated into URLs or hrefs without encoding.
- No secrets or tokens stored in `localStorage`.

## High-Scrutiny Surfaces

Escalate immediately if a change touches: `apps/auth/`, payments, `common/permissions.py`, leaves, payroll, or project_logs.
