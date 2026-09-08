---
name: react-frontend-standards
description: React coding rules, architecture patterns, and performance requirements for this ERP repo. Used by frontend-agent when building components, containers, hooks, styles, and forms.
---

# React Frontend Standards

## Architecture Rules

- Strict container/component separation — containers handle logic + state + API calls, components handle UI only
- Max 200 lines per file, max 50 lines per function
- Functional components only, arrow functions only
- PropTypes required on every component

## Component Reuse — Hard Rule

- **Before creating any new UI primitive** (dialog, modal, alert, drawer, snackbar, confirmation popup, status chip, badge, button row, etc.), search the shared component locations and reuse the existing one if its API can satisfy the need:
  1. `frontend/src/components/utils/` — ~100 reusable primitives. The dialog/modal family alone includes `ConfirmationDialogBox`, `AlertModal`, `ConfirmationModal`, `InformationModal`, `ExternalCommitmentModal`, `MaterialModal`, `DialogHeading`. There is also `ActionButton`, `Tooltip`, `Skeleton`, etc.
  2. `frontend/src/components/shared/components/` and `frontend/src/components/shared/containers/` — cross-module reusables.
- A new one-off component that visually duplicates a shared one (same intent, slightly different styling) is forbidden. The shared component owns the visual system; building a parallel one creates style drift that is visible to users (different fonts, paddings, button variants) and creates maintenance debt.
- If the shared component is *almost* a fit but missing one prop, extend the shared component's API (add a prop with a safe default) rather than fork. If extension would balloon the component's surface area unreasonably, surface that to the user with the trade-offs and ask before forking.
- Concrete check before creating anything dialog-like:
  ```bash
  ls frontend/src/components/utils/ | grep -iE "dialog|modal|alert|confirm|popup|drawer|snackbar"
  grep -rln "ConfirmationDialogBox\|AlertModal\|InformationModal" frontend/src --include="*.js" | head
  ```
  At least one of the imports should match the use case. If none does, justify the gap before writing new component code.

## Style & Schema Rules

- NEVER inline styles — all styles in `styles/<module>Styles.js`
  - Exception: truly dynamic values only e.g. `sx={{ width: \`${progress}%\` }}`
- NEVER inline Yup schemas — all validation in `formValidations.js`
- Named imports only from icon libraries — never `import *`

## API-Helper Rules

- NEVER `import axios` (or call `axios.{get,post,put,patch,delete}`) inside helpers, containers, hooks, or components. The only files allowed to import axios are `common/utils/serverCalls.js`, `helper/helper.js`, and `login/loginHelpers.js`. Everywhere else, use the wrappers exported from `common/`: `apiGet`, `apiPost`, `apiPut`, `apiPatch`, `apiDelete`, `apiDestroy`, `apiGetBlobType`, `apiPostBlobType`.
- Before writing a new helper, scan a sibling helper file in the same module (or any file under `components/**/logic/helpers/`) to confirm the import shape and call style. If the new code does not match the existing pattern in similar files, you are doing it wrong — match the pattern, do not invent a new one.
- If an existing wrapper does not fit the endpoint shape (e.g. a singleton DELETE without an id, a custom header, a non-standard URL composition), the correct fix is to extend the shared wrapper in `common/utils/serverCalls.js` in a backwards-compatible way — NOT to bypass it by importing axios inline. Bypassing the wrapper fragments the API surface and is forbidden.

## Performance Rules

- Parallelize independent API calls with `Promise.all()`
- No cascading `useEffect` hooks
- Lazy-load heavy components with `React.lazy()`
- Virtualize lists with 100+ rows using `react-window`
- `useMemo` for expensive computations; `useCallback` for functions passed as props
- Stable keys on lists (never array index)
- Debounce search/filter inputs (300ms)
- Cache `localStorage`/`sessionStorage` reads — never read inside render bodies

## Comment style — hard rules

- **NEVER write inline comments** in JS/JSX (`// ...` or `/* ... */`). No section banners, no "step 1 / step 2" trails, no "this does X" restatements of the next line.
- JSDoc on a function/component is allowed when it documents *why* or non-obvious invariants. Default to no JSDoc; rely on clear names and PropTypes.
- If you feel the urge to write an inline comment, choose one of: rename the variable/function, extract a named helper, or add the explanation to the JSDoc of the enclosing function.

## Imports — hard rules

- **All imports go at the top of the module.** No `import(...)` calls or `require(...)` inside functions or branches.
- Lazy-loading via `React.lazy(() => import('...'))` is the only allowed inline import; it is part of the React API, not a workaround.
- If a top-level import would cause a real circular dependency, **stop and inform the user** with the import chain and a structural fix proposal. Do not silently work around it.

## ESLint-disable — hard rules

- **Disabling ESLint is a code smell, not a fix.** `// eslint-disable-line`, `// eslint-disable-next-line`, `/* eslint-disable */` blocks, and equivalents bypass the team's safety net. Write code ESLint accepts.
- Common cases and the right fix:
  - `react-hooks/exhaustive-deps` → add the missing dep, or wrap the value in `useCallback`/`useMemo`, or hoist it. Do NOT disable.
  - `max-len` → break the line.
  - `no-unused-vars` → delete it.
- If a disable is genuinely necessary (e.g. a stable ref that must not retrigger an effect, with reasoning that survives reading), **stop and inform the user** with the file/line, the rule, why the alternatives fail, and proceed only after affirmation. When affirmed, scope the disable to a single line with one rule.

## QA Workflow

- After writing code: take a screenshot with Playwright, self-correct any visual issues
- Run `npm run lint` — must be zero errors before reporting done
- Report: screenshot + list of changed files + ESLint clean
