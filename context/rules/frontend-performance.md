# Frontend Performance

## Request Waterfalls (Critical)

- Never sequential `await` for independent calls — use `Promise.all()`.
- Never cascading `useEffect` chains where effect A sets state that triggers effect B. Combine into one effect.

```javascript
// BAD — 3× latency
const user = await fetchUser();
const posts = await fetchPosts();

// GOOD — 1× latency
const [user, posts] = await Promise.all([fetchUser(), fetchPosts()]);
```

## Memoization

- `useMemo()` for expensive computations.
- `useCallback()` for callbacks passed as props to children.
- `React.memo()` for components that re-render without prop changes.
- Do not create new object/array/function literals inline as props to memoized children — hoist or wrap.

## Lazy Loading

- `React.lazy()` + `Suspense` for heavy below-the-fold components (charts, modals, dashboards).
- Route-based code splitting per module (rewards, training, expenses, invoices).

## Virtualization

- Lists with 100+ items must use `react-window` or `react-virtualized`.

## Storage Reads

- Cache `localStorage` / `sessionStorage` / `document.cookie` reads in a module-scope variable. Do not read synchronous storage on every render.

## Debouncing

- Debounce search and filter inputs at 300ms.
