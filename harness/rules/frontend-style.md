# Frontend Style Rules

## Imports

- Named imports only from icon and UI libraries — never `import *`.
- Order: builtin → external → internal → parent → sibling → index.
- Alphabetize within each group.

## No Inline Styles

- Never use `sx={{...}}` or `style={{...}}` in JSX.
- Place all styles in `styles/<module>Styles.js`.
- Exception: truly dynamic values bound to props/state, e.g. `sx={{ width: `${progress}%` }}`.

## Validation Schemas

- All Formik / Yup schemas go in `formValidations.js` at the module level.
- Never define schemas inline in component files.

## react-select Styling

Use a custom hook in the module styles file:

```javascript
export const useMySelectStyles = () => {
  const theme = useTheme();
  return {
    placeholder: (p) => ({ ...p, color: theme.colors.textSecondary }),
    control: (p) => ({ ...p, borderColor: theme.colors.gray800 }),
  };
};
```

## PropTypes

- Required on every React component. Use `PropTypes.shape()` for objects.
- Pass only the fields a component needs — not entire objects.

## List Keys

- Always use stable unique IDs — never array index on reorderable or filterable lists.

## Components

- Functional arrow-function components only — no class components.
- No `console.log` in committed code. `console.error` / `console.warn` allowed when justified.
- No magic numbers — extract to named constants.

## Comments

- **Never write inline `//` or `/* */` comments** while writing code. Component, function, and prop names are the explanation.
- No commented-out code.
- Do not reference the current ticket, MR, fix, or callers in code — that context belongs in the PR description.
