# Frontend Structure

## Container / Component Split

- Containers (`containers/`): state, API calls, side effects, Redux. Never render raw HTML directly — delegate to sub-components.
- Components (`components/`): presentational only. Receive data via props, emit events up. No API calls, no state management.
- Never mix business logic into presentational components.

## Module Layout

```
components/<module>/
  components/           # Presentational
  containers/           # Logic & state
  utils/                # Helpers (transforms, formatters, calculations)
  styles/               # All sx/style objects
  formValidations.js    # All Yup schemas
```

## File & Function Limits

- Max **200 lines** per file (blank lines and comments excluded).
- Max **50 lines** per function.
- Max **4 parameters** per function — use an options object beyond that.
- Max nesting depth: **3 levels**.

When approaching limits:
1. Extract helpers → `utils/`
2. Split into sub-components
3. Create custom hooks for reusable stateful logic
4. Move constants to a constants file
5. Move styles to the module's styles file

## Utility Extraction

Move to `utils/` any function that does data transformation, formatting, validation, filtering, sorting, or calculation.

Keep inside the component only: event handlers that set local state, render logic, component-specific hooks.

Before writing a new util, check `common/` and existing module `utils/` — extend before duplicating.
