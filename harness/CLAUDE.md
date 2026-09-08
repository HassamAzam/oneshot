# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**Workstream** is a Django + React ERP application for HR, payroll, project management, and business operations.

- **Backend**: Django 4.x (Python 3.12) + Django REST Framework
- **Frontend**: React 18.3.1 + Redux + Material-UI v6
- **Async**: Celery + Redis
- **Database**: PostgreSQL 14
- **Build**: Webpack 4

---

## Commands

### Backend
```bash
python manage.py runserver          # Start Django dev server (port 8000)
python manage.py migrate            # Run migrations
celery -A hrdb worker -Q celery,long_running --pool=threads  # macOS Celery
pytest                              # Run all Django tests
pytest apps/leaves/tests/           # Run tests for a specific app
ruff check .                        # Python linting
```

### Frontend
```bash
npm start                           # Dev server (port 3000)
npm run build                       # Production build
npm test                            # Run Jest tests
npm test -- --testPathPattern=rewards  # Run tests for a specific module
npm run lint                        # ESLint check
npm run lint:fix                    # Auto-fix ESLint issues
npx eslint src/components/rewards/**/*.js  # Lint specific module
```

### Docker
```bash
docker-compose up --build -d        # Start all services
docker-compose stop
docker-compose down -v
```

---

## Architecture

### Backend Structure

34+ Django apps in `apps/`, each owning a business domain (leaves, payroll, invoices, users, etc.). Shared utilities live in `common/`.

Each app follows:
```
apps/<module>/
  models.py       # Data models
  views.py        # DRF ViewSets and endpoint-specific flow
  serializers.py  # Input validation + output formatting — never inline
  utils.py        # Shared helpers, formatting, query helpers, reusable business logic
  urls.py         # URL routing
  tasks.py        # Celery async tasks
```

Django project config is in `hrdb/` (settings, urls, wsgi). Root URL routing in `hrdb/urls.py` includes each app's URLs.

### Frontend Structure

Business modules live in `frontend/src/components/<module>/`, each structured as:
```
components/<module>/
  components/         # Presentational only — receive props, render UI
  containers/         # Logic, state, API calls, Redux connections
  utils/              # Helper functions (data transforms, formatting, calculations)
  styles/             # All sx/style objects — e.g. rewardStyles.js
  formValidations.js  # All Yup schemas for this module
```

Redux store (`frontend/src/store/`) manages global state. Actions and reducers are in `frontend/src/actions/` and `frontend/src/reducers/`. Route definitions are in `frontend/src/routes.js` (100+ routes with lazy loading per module).

---

## Module Linkages

Cross-cutting dependencies between major apps. When working on one, consider impact on the others.

- **Payroll <-> Leaves**: Unpaid leaves reduce net salary. Two monetary benefits — **Leave Fare Assistance (LFA)** and **Leave Encashment** — bridge the apps with a bidirectional offset that prevents double-benefit on the same fiscal-year leave pool. Mechanics in `apps/leaves/CLAUDE.md`, `apps/payroll/CLAUDE.md`, `apps/odoo/CLAUDE.md`.
- **Payroll <-> Costing**: `PersonCost` derived from salary + increments + allowances + bonuses. `CurrencyRate` in payroll is the single source of truth for all PKR/USD conversion in costing.
- **Payroll <-> Expenses**: Some expense types reimbursed via payroll. Medical expense limits may tie to compensation level.
- **Payroll <-> Invoices**: Subcontractor invoices defined in payroll, referenced by invoices app. `BillingOrganization` from invoices used in subcontractor models.
- **Payroll <-> Rewards**: Bonus history used in reward calculations. Teams app serializers expose payroll data.
- **Costing <-> Invoices**: Project costs matched against invoice revenue for profitability. `NonInvoicedRevenue` captures gaps.
- **Costing <-> Expenses**: Approved expenses factored into person/project costs. Transport and fuel have dedicated costing models.
- **Leaves <-> Costing**: Unpaid leave reduces person cost for that month.
- **Allowances <-> Payroll**: `Allowance`, `AllowanceLimit`, and `AllowancePersonStatusBridge` models defined in payroll. Limit computation uses `CurrencyRate` for USD conversion.
- **Allowances <-> Users**: `AllowanceRequest` in users references `Allowance` from payroll. Approval flow has lead and people-partner reviewers (`Person` FKs).
- **Forms <-> Payroll**: Final settlement reminders triggered from forms app.
- **Payroll <-> Odoo**: Signals in payroll trigger Odoo salary rule/payroll structure sync. `OdooBadCallException` can silently fail if not handled.
- **Core / Competencies <-> Integrations (Sophia)**: The user-skills feature in `apps/integrations/sophia/` proxies to the external Sophia system — skill title/rating live on Sophia, ERP keeps only the title↔category mapping in `PersonSkillCategory` (`SkillCategory` is the local taxonomy), gated by `USE_SOPHIA_SKILLS`. Person / PersonTeam / Team mutations sync outbound via signals. Inbound Sophia reads are gated by `SOPHIA_INBOUND_*` settings (with `SOPHIA_EXTERNAL_API_*` fallback) in `apps.competencies.permissions.SophiaAccessPermission` and `apps.integrations.sophia.permissions.SophiaExternalIntegrationAccessPermission`.

---

## Coding Rules (Authoritative)

Domain-split standards live in [`.claude/rules/`](.claude/rules/). Read the relevant file before changing code in that area — these are the source of truth and override the abbreviated `Coding Standards` section below when they conflict.

| File | Scope |
|------|-------|
| [`.claude/rules/branching.md`](.claude/rules/branching.md) | Base/target branch selection by discovery environment, promotion & back-merge flow |
| [`.claude/rules/backend-django.md`](.claude/rules/backend-django.md) | Views, serializers, ORM, models, migrations, Celery |
| [`.claude/rules/backend-python.md`](.claude/rules/backend-python.md) | Pylint conventions, naming, error handling, logging |
| [`.claude/rules/frontend-structure.md`](.claude/rules/frontend-structure.md) | Container/component split, file/function limits, util extraction |
| [`.claude/rules/frontend-style.md`](.claude/rules/frontend-style.md) | Imports, inline styles/schemas, PropTypes, keys |
| [`.claude/rules/frontend-performance.md`](.claude/rules/frontend-performance.md) | Waterfalls, memoization, lazy loading, virtualization |
| [`.claude/rules/solid.md`](.claude/rules/solid.md) | SOLID applied to Django + React |
| [`.claude/rules/security.md`](.claude/rules/security.md) | Secrets, input validation, permissions, XSS |
| [`.claude/rules/testing.md`](.claude/rules/testing.md) | Coverage expectations, test organization |

---

## Coding Standards

### Django
- Follow SRP: each view, serializer, helper, and model method should have one clear purpose
- Keep view logic endpoint-focused and readable; extract shared or repeated logic to `utils.py`, managers, or model methods
- Do not introduce `services.py` by default just to relocate code
- Follow pylint-friendly Python standards: clear naming, no unused imports, and no broad exceptions without context
- Use class-based views (ViewSets) for CRUD; function-based for simple endpoints
- Type hints on all new functions; docstrings on non-trivial models and helpers
- Optimize queries with `select_related()` / `prefetch_related()` — never N+1
- Always create and commit migrations when models or schema change

### React — Hard Rules (ESLint enforced)
- **Max 200 lines per file**, **max 50 lines per function** — split or extract when approaching limit
- **No inline styles** — never `sx={{...}}` or `style={{...}}` in JSX; all styles in `styles/<module>Styles.js`
  - Exception: truly dynamic values only e.g. `sx={{ width: \`${progress}%\` }}`
- **No inline Yup schemas** — all validation in `formValidations.js` at module level
- **PropTypes required** on every component
- **Functional components + arrow functions only** — no class components
- No `console.log` — use `console.error` or `console.warn` only
- Imports organized by group (builtin → external → internal → relative), alphabetized within groups

### React — Container vs Component Separation
- **Containers**: own all state, API calls, side effects, Redux. Never render raw HTML — use sub-components.
- **Components**: presentational only. No API calls. Emit events up via props.

### React — Performance (Critical)
```javascript
// ❌ Sequential awaits for independent calls — 3x latency
const user = await fetchUser();
const orders = await fetchOrders();

// ✅ Parallel — 1x latency
const [user, orders] = await Promise.all([fetchUser(), fetchOrders()]);
```

```javascript
// ❌ Cascading useEffect — creates waterfalls
useEffect(() => { fetchUser().then(setUser) }, [])
useEffect(() => { if (user) fetchPosts(user.id).then(setPosts) }, [user])

// ✅ Single effect
useEffect(() => {
  async function load() {
    const user = await fetchUser();
    const posts = await fetchPosts(user.id);
    setUser(user); setPosts(posts);
  }
  load();
}, []);
```

- Named imports only from icon libraries — never `import *`
- Lazy-load heavy components with `React.lazy()`; virtualize lists 100+ rows with `react-window`
- Debounce search/filter inputs (300ms)
- `useMemo` for expensive computations; `useCallback` for functions passed as props; stable keys on lists (never array index)

### react-select Styling Pattern
Use a custom hook in the module's styles file:
```javascript
// styles/moduleStyles.js
export const useMySelectStyles = () => {
  const theme = useTheme();
  return {
    placeholder: (provided) => ({ ...provided, color: theme.colors.textSecondary }),
    control: (provided) => ({ ...provided, borderColor: theme.colors.gray800 }),
  };
};
```

---

## Git & CI

### Branching

The base branch is **not always `dev`** — it follows the environment where the issue was discovered. Promotion runs `dev → stage → master`; back-merges (`master → stage → dev`) carry fixes downstream. **Read [`.claude/rules/branching.md`](.claude/rules/branching.md)** for the model, decision table, and signal-detection procedure, or run `/pick-base-branch` to have it resolved.

- **base == target == the branch of the environment where the issue was found.** New feature work (no pre-existing bug) defaults to `dev`. Prod bugs → `master` (via `/create-adhoc`); staging bugs → `stage`; in-flight feature bugs → that feature branch.
- **Pull latest before branching:**
  ```bash
  git fetch origin <base>            # base = dev | stage | master | <feature-branch>
  git checkout <base>
  git pull --ff-only origin <base>
  git checkout -b <username>/<topic-or-ticket>
  ```
- If you branched from the wrong place, rebase onto the **correct target** — not always `dev`: `git fetch origin <target> && git rebase origin/<target>`. Renumber any migrations that collide with ones merged into the target during your work.

### Commits & CI

- **Never commit directly to `main`, `master`, `dev`, or `develop`**
- Commit format: `feat: add invoice filter (#88)` — always reference ticket number
- Conventional prefixes: `feat:`, `fix:`, `chore:`, `refactor:`, `test:`
- Escalate immediately if changes touch `apps/auth/`, payments, or `common/permissions.py`
- CI runs: pytest, Jest, ruff, ESLint — all must pass before merge

---

## Pre-commit Checklist

- [ ] File under 200 lines; functions under 50 lines
- [ ] Container/Component separation maintained
- [ ] No inline styles or inline Yup schemas
- [ ] All reusable logic extracted to `utils/`
- [ ] ESLint zero errors; PropTypes defined; no `console.log`
- [ ] Independent API calls use `Promise.all()`; no cascading `useEffect`
- [ ] Named imports only from icon libraries
- [ ] Python changes stay pylint-friendly and avoid duplicated helpers
- [ ] Migrations are included whenever models or schema changed
