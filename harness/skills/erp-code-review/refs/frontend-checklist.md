# Frontend Review Checklist

Authoritative: `.claude/rules/frontend-performance.md`, `.claude/rules/frontend-style.md` (React anti-patterns) and `.claude/rules/frontend-structure.md` (container/component split, file limits). This file is a checklist, not a rulebook — read the spec when you need depth.

## Universal (every frontend diff)

- [ ] No `console.log` in committed code (`console.error` / `console.warn` allowed when justified)
- [ ] No commented-out code
- [ ] No hardcoded secrets, tokens, or API keys
- [ ] No magic numbers — use named constants
- [ ] No inline `sx` / `style` props — centralized style file
- [ ] No inline Yup / Formik schemas — extracted to `formValidations.js`
- [ ] No wildcard imports from icon / UI libs — named imports only (`import { X } from 'lucide-react'`)
- [ ] User-facing strings go through `displayText` (i18n-ready)
- [ ] New styling uses MUI styled components (JSS → MUI migration in progress; do not add JSS)

## Container / component split

- [ ] Business logic, data fetching, and state live in containers — not components
- [ ] Presentational components receive props and render — they do not fetch or hold domain state
- [ ] Containers do not render deep JSX themselves — delegate to components
- [ ] Shared hooks extracted to `hooks/` — no copy-paste logic across containers

## File / function limits

- [ ] File < 200 lines (ESLint enforces but diffs can slip)
- [ ] Function < 50 lines
- [ ] Component nesting depth ≤ 4

## Props

- [ ] PropTypes defined on every new component (or TS types if the file is TS)
- [ ] Component receives only the props it uses — no "pass the whole object down" (ISP)
- [ ] No anonymous object/array literals passed as props to memoized children (causes re-render)

## Re-render bugs (high-value category)

- [ ] New `{}` / `[]` / `() => ...` literals passed as props → hoist or wrap in `useMemo` / `useCallback`
- [ ] Context value not wrapped in `useMemo` when the value is an object
- [ ] `useEffect` depending on a ref or object recreated every render
- [ ] Parent re-render doesn't force children that should be stable to also re-render

## Hooks correctness

- [ ] `useEffect` dependency arrays complete (or intentional omission documented inline)
- [ ] No cascading effects — effect A sets state read by effect B → collapse into one
- [ ] No stale closures in event handlers, intervals, or subscriptions
- [ ] `useState` doesn't hold values derivable from props — compute them
- [ ] Custom hooks start with `use` and follow the Rules of Hooks
- [ ] Cleanup functions returned from effects that set up subscriptions / timers / listeners

## Data fetching

- [ ] Independent requests parallelized with `Promise.all` — no sequential `await` waterfalls
- [ ] Loading and error states rendered — not just the happy path
- [ ] Optimistic updates roll back on failure with visible error feedback
- [ ] Server state not duplicated into local state (source of truth is the server cache)

## Lists

- [ ] Stable keys — no `key={index}` on reorderable / filterable lists
- [ ] Lists with 100+ items virtualized with `react-window` (or equivalent)
- [ ] No expensive computation on every render — memoize per item

## Storage

- [ ] `localStorage` / `sessionStorage` / `cookie` not read inside render bodies — cache in a ref or module scope
- [ ] No tokens or secrets in `localStorage` (XSS-reachable)

## Security

- [ ] No `dangerouslySetInnerHTML` without sanitization
- [ ] User input not interpolated into `href` / `src` without URL encoding
- [ ] No `eval` or `Function()` on dynamic content
- [ ] External links with `target="_blank"` have `rel="noopener noreferrer"`

## Accessibility (spot-check)

- [ ] Interactive elements are real `<button>` / `<a>` — not `<div onClick>`
- [ ] Form inputs have labels (`<label htmlFor>`) or `aria-label`
- [ ] Images have `alt` text
- [ ] Keyboard navigation works for new interactive UI

## Utilities

- [ ] No inline formatters, validators, sorters, filters — extract to `utils/`
- [ ] Single-module utility → `<module>/utils/`; shared → `frontend/src/common/**`
