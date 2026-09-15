---
name: frontend-accessibility
description: Accessibility (a11y) audit and fix guidance for this ERP's MUI v6 + React frontend — color contrast, ARIA semantics, keyboard navigation, focus management, and screen-reader correctness against WCAG 2.1 AA. Trigger on "accessibility", "a11y", "WCAG", "screen reader", "keyboard nav", "contrast", "aria-*", or when asked to audit/fix/review a component or page for accessibility. Also loaded by accessibility-reviewer-agent during erp-code-review — this file is the single source of truth for both standalone use and MR review.
---

# Frontend Accessibility (MUI v6 + React)

## Why this exists

This ERP is used daily by employees on assistive tech to submit leaves, approve invoices, and run payroll — workflows with real consequences when they're unusable. `frontend-reviewer-agent` covers performance and structure; nothing else in this repo owns accessibility end to end. This skill does.

Target: **WCAG 2.1 AA**. MUI v6 gets you most of the way there by default — most violations in this codebase come from *fighting* MUI's built-in a11y (overriding focus behavior, replacing semantic components with `<div>`s) rather than from MUI itself.

## Scope

- **Direct invocation**: "audit this page for accessibility", "is this modal keyboard-accessible", "fix a11y issues in X". Read the target file(s) (and their imported sub-components) and work the checklist below.
- **Via `accessibility-reviewer-agent`**: dispatched by `erp-code-review` on frontend diffs. Same checklist, diff-scoped, structured findings output (see bottom).

## Checklist

### Interactive elements

- [ ] Clickable elements are real `<button>` / `<a>` / MUI `Button`/`IconButton`/`Link` — never `<div onClick>` or `<span onClick>`. A `<div>` gets no keyboard focus, no Enter/Space activation, no accessible role.
- [ ] `IconButton` with only an icon child has an `aria-label` describing the action (`aria-label="Delete increment"`), not the icon name (`aria-label="TrashIcon"`).
- [ ] Every focusable element is reachable and operable via keyboard alone — Tab to reach it, Enter/Space to activate, Escape to dismiss overlays. No handler wired only to `onClick`/`onMouseDown` without an equivalent key handler when the element isn't a native control.
- [ ] No keyboard trap — a modal/drawer/menu must let Tab cycle within it and Escape close it, never strand focus.
- [ ] `Tooltip` wrapping a `disabled` MUI control is wrapped in an extra `<span>` — disabled elements don't fire the mouse/focus events `Tooltip` listens for, so the tooltip silently never shows.

### Focus management

- [ ] Opening a `Dialog`/`Modal`/`Drawer` moves focus inside it (MUI `Dialog` does this by default — don't disable with `disableAutoFocus`/`disableEnforceFocus` without a documented reason).
- [ ] Closing it returns focus to the triggering element (also automatic in MUI `Dialog` — don't fight it by manually moving focus elsewhere on close).
- [ ] Route/tab changes that swap the visible panel move focus to the new panel's heading, not leave it on a now-invisible element.
- [ ] No `autoFocus` on a field inside a list/repeated component — it steals focus from whichever instance rendered last.
- [ ] Focus order matches visual order. DOM order drives Tab order, but reversed flex directions, `order`, grid placement and absolute positioning change only what is seen. Read the container's styles before reasoning about where a control lands in the Tab order.

### Forms

- [ ] Every `TextField`/`Select`/`Checkbox`/`RadioGroup` has a real `label` prop, or `aria-label` if a visible label is intentionally absent. A `placeholder` alone is not a label — it disappears on input and isn't consistently read by all screen readers.
- [ ] Validation errors are wired through MUI's `error` + `helperText` props (MUI auto-links `helperText` via `aria-describedby`) — a custom error `<Typography>` rendered next to the field without that wiring is invisible to assistive tech.
- [ ] Required fields are marked with `required` (MUI renders `aria-required`) — not just a visual `*` in the label text.
- [ ] Grouped radio/checkbox sets have a `FormLabel`/`legend` naming the group, not just individual option labels.

### Status, color, and live regions

- [ ] Status is never conveyed by color alone (a red/green `Chip` with no icon or text is unreadable to colorblind users and screen readers). Pair color with an icon or text label — this matters most on approval/status chips in payroll, leaves, and invoices.
- [ ] Color contrast meets **4.5:1** for normal text and **3:1** for large text (≥18px/24px bold) and UI component boundaries (input borders, focus rings). Check actual theme tokens (`theme.colors.*`) — don't eyeball it; a custom color added to the theme needs the same check as inline text.
- [ ] Contrast is measured against the **composited background the element actually renders on**, not the theme's default surface. See "Measuring contrast" below — a ratio computed against a default surface token is a guess until the real surface is resolved.
- [ ] Async loading states expose `role="status"` or an `aria-live="polite"` region so a screen reader announces "loading" / "loaded" — a bare spinner with no text alternative is silent.
- [ ] An announcement made while a `Dialog`/`Modal`/`Drawer` is open comes from a live region **inside** that overlay. MUI's `ModalManager` sets `aria-hidden="true"` on every sibling of the portal — including the app root and any app-wide announcer mounted in it — so an app-wide live region goes silent exactly while the overlay is open. Render the live region inside the overlay.
- [ ] Toasts/snackbars use `role="alert"` (errors, `aria-live="assertive"`) or `role="status"` (info, `aria-live="polite"`) so they're announced without requiring focus.

### Images and icons

- [ ] Meaningful images have descriptive `alt` text; purely decorative images/icons have `alt=""` (not a missing `alt`, which forces screen readers to announce the filename).
- [ ] An icon used as the *sole* indicator of meaning (e.g., a status icon with no adjacent text) has an accessible name via `aria-label` or visually-hidden text.

### Lists, tables, and virtualization

- [ ] Data tables use semantic `<table>`/`<thead>`/`<th scope="col">` (MUI `Table` does this) — not styled `<div>` grids pretending to be tables.
- [ ] Sortable column headers expose `aria-sort` reflecting current state.
- [ ] `react-window`-virtualized lists (required at 100+ rows per `.claude/rules/frontend-performance.md`) preserve list semantics — wrap with `role="list"` and give rows `role="listitem"`, since virtualization removes off-screen DOM nodes that screen readers otherwise rely on for list-length announcements.

### Landmarks and structure

- [ ] Page has one `<h1>`/top-level heading; heading levels don't skip (`h2` → `h4` with nothing between).
- [ ] Page regions use landmark roles/elements (`<nav>`, `<main>`, `header`/`aria-label` on repeated regions) so screen reader users can jump between them instead of reading linearly.

## Measuring contrast

A ratio is only as good as the two colours fed into it, and the background is the one that gets guessed. Before you report a ratio or pick a replacement colour:

1. **Resolve the real surface for every place the element renders.** Walk up from the element to the first opaque background. Look for `!important` overrides, interaction and state styles (hover, selected, expanded, disabled), and translucent overlays — a semi-transparent layer blends with what is under it, so the backdrop is neither colour on its own. A component reused in two places can sit on two different backgrounds; check each.
2. **Check every theme mode the page supports** (light and dark at minimum). A colour that passes on one can fail on the other, and a fix tuned for light mode can regress dark.
3. **Opacity multiplies and cannot be undone by a child.** An ancestor with `opacity: 0.5` halves every descendant's effective contrast, and `opacity: 1` on the child does nothing. The fix is structural — the element leaves the translucent ancestor, or the dimming moves off the shared parent — never a "reset" on the child.
4. **Compute, don't estimate.** Use MUI's `getContrastRatio` or the WCAG relative-luminance formula; blend any alpha into its backdrop first.
5. **Say how you got the number.** A ratio computed from source against an assumed surface is `static, unverified` until a rendered page confirms it (see Dynamic verification). A planning or research step that could not render the page must label its ratios that way, so a later step does not treat them as settled.

A test that asserts a colour against a default surface only proves the colour — it passes while the rendered element still fails. Assert against each resolved surface.

## Scoping a WCAG ticket

Audit-generated tickets often name a criterion and a page but not the elements ("the Unknown screen"). Fixing the first instance you find is how a ticket ships "fixed" and fails re-audit.

- **Inventory before fixing.** List every instance on the in-scope page(s), and find them by search rather than by reading components one at a time: grep the page's style sheets and components for colour tokens, hex/rgba literals, `opacity`, status/indicator class names. Record the searches, so a reviewer can see what was covered. If a sub-agent produced the inventory, spot-check it against your own grep before relying on it.
- **Per criterion, what the inventory must cover:**
  - **1.4.11 Non-text Contrast (3:1)** — status dots/bars/legends, icons that carry meaning, input and checkbox/radio/switch boundaries, **focus indicators**, selected/active states, chart marks, progress bars. Focus rings are the most common miss; check them explicitly.
  - **2.4.5 Multiple Ways** — the unit is the *set of pages*, not any one navigation component. Each page needs more than one way to be located, except pages that are a step in a process or the result of one; derive the page set from its source of truth and state which exemption applies where one does.
  - For any other criterion, read its definition and exceptions before scoping; don't infer scope from the ticket title.
- **Scope choices are questions, not decisions.** When the ticket leaves a scope boundary open (which screens, roles, versions, themes or breakpoints count, what evidence satisfies a criterion), record it as an open question with the default you assume, and list what you deliberately left out. Do not silently pick.
- **Acceptance criteria that cannot be met as written** (a tool or check that cannot measure the criterion) are called out as such, with what will be shown instead.

## Fix patterns (MUI v6)

```jsx
// ❌ No accessible name — screen reader announces "button"
<IconButton onClick={handleDelete}><DeleteIcon /></IconButton>

// ✅
<IconButton onClick={handleDelete} aria-label="Delete increment"><DeleteIcon /></IconButton>
```

```jsx
// ❌ Tooltip never appears — disabled button fires no events
<Tooltip title="Requires approval"><Button disabled>Submit</Button></Tooltip>

// ✅
<Tooltip title="Requires approval">
  <span><Button disabled>Submit</Button></span>
</Tooltip>
```

```jsx
// ❌ Color-only status
<Chip label={status} sx={{ backgroundColor: statusColor }} />

// ✅ Color + icon/text — still no inline sx per frontend-style.md, use styles/<module>Styles.js
<Chip label={status} icon={<StatusIcon status={status} />} sx={statusChipStyles(status)} />
```

```jsx
// ❌ Fake table
<Box role="grid">{rows.map(row => <Box key={row.id} role="row">...</Box>)}</Box>

// ✅ Real table semantics, or MUI DataGrid, which handles this for you
<Table><TableHead>...</TableHead><TableBody>...</TableBody></Table>
```

## Dynamic verification (when Playwright is available)

Static review catches most issues, but contrast and computed-role checks are more reliable measured against a rendered page. If `mcp__playwright` is available (it is for `frontend-agent`/`qa-agent`), run an automated scan against the dev server rather than estimating contrast by eye:

1. `npm start` (or confirm it's already running on port 3000).
2. Navigate Playwright to the target page/component.
3. Inject and run `axe-core` (`https://unpkg.com/axe-core@latest/axe.min.js` is blocked in sandboxed contexts — vendor a local copy under `frontend/node_modules/axe-core/axe.min.js` if present, or fall back to static review and say so).
4. Report violations with the DOM selector axe returns, mapped back to the source file/component.
5. For contrast, confirm the colours axe (or your own check) used: read `getComputedStyle(el).color` / `backgroundColor` up the ancestor chain to the first opaque background, and multiply the `opacity` of every ancestor. Do this in each theme mode and in each view the component appears in.

Do not claim a dynamic scan ran if it didn't — say "static review only" when Playwright/axe wasn't actually exercised.

## Output format (used by both direct invocation and `accessibility-reviewer-agent`)

```
[SEVERITY] <path>:<line> — <problem>
  Fix: <concrete suggestion>.
```

Severity, consistent with `.claude/skills/erp-code-review/refs/severity-rules.md`:

- **BLOCKER** — keyboard trap, no accessible name on an interactive control, color-only status on an approval/payroll/leave workflow, form field with no label, focus lost on modal open/close, live region rendered outside an open overlay (silent by construction).
- **SUGGESTION** — borderline contrast, contrast ratio reported against an unresolved surface or labelled static/unverified, missing `aria-live` on an async update, virtualized list missing list semantics, heading level skip.
- **NITPICK** — redundant `aria-label` duplicating visible text, minor landmark structure gaps.

If the target is clean: `Clean — no accessibility findings.` Silence means pass — do not list passing checklist items.

## Do NOT

- Do NOT flag issues ESLint's `jsx-a11y` plugin already catches if it's configured — check `.eslintrc` first; trust CI for what it enforces.
- Do NOT restate `.claude/rules/frontend-style.md` styling rules (inline `sx`, schema location) — that's `frontend-reviewer-agent`'s scope. Only flag a style violation here if it's the direct cause of an a11y failure (e.g. a color-only status chip).
- Do NOT invent WCAG success-criterion numbers you haven't verified — describe the concrete failure instead of citing "SC 1.4.3" from memory.
