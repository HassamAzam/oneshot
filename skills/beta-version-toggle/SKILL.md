---
name: beta-version-toggle
description: Build a change to an existing ERP feature as a new version (v2) beside the old one (v1), with a switch that lets the end user go back to v1 and forward again — on the layout Project Logs v2 uses (a sibling `<module>_v2/` directory, one route wrapper that picks the version at the same URL). Use when a ticket carries the Beta label, or when asked to "ship this as a beta", "build a v2 beside the old version", "let users switch back to the old screen", "add a toggle to revert to the old feature". Covers the v1/v2 directory split, the one switch point, where the user's choice is kept, and each Oneshot phase's part in it (plan, implement, testcases, review, verify, ui-evidence, mr).
---

# Beta version toggle

Ship a change to an existing feature as a second version beside the first, and let
the person using it choose. A rework that replaces the old screen has one way back
when it is wrong — a revert and a redeploy. A rework built beside it has a switch
the user flips in a second, while the team fixes v2.

**The label is the requirement.** Triage put `Beta` on the ticket, so "v2 beside v1,
with a switch" is stated scope, not a preference to trade away. `ponytail` never
simplifies away anything explicitly requested, so its "does this need to exist?"
does not fold v2's copy of a screen back into v1's. Everything else stays lazy:
v1's data layer is imported, not copied, and the switch is the smallest thing that
works.

**The layout is Project Logs v2's; the switch is new.** Project Logs v2 (squash
`812042141b`, "Project Logs Refactor Beta") is the one feature ERP has built
this way, and every path below is on `origin/dev`. But it has no user switch: its
version comes from a server allowlist (`LOGS_V2_TESTER_PERSON_IDS` in
`hrdb/settings.py` → `logs_v2_testing` in `/api/v1/core/person_permission/`), and
moving anyone between versions takes a commit and a deploy. Copy its layout, not
its gate.

## 1. Is there a v1?

A beta needs something to go back to. Name it before planning: the screens and
routes the ticket changes, as they are on the base branch, and the directory that
renders them.

- **The ticket reworks an existing screen** — that screen is v1. The normal case.
- **It adds to an existing screen** (a column, a panel, a step) — v1 is the screen
  without it, v2 the screen with it.
- **It creates a screen that does not exist today** — there is no v1 and nothing to
  switch back to. Do not invent one. Record it in `openQuestions` with the default
  "ship it without a switch" and carry on as an ordinary ticket. A switch between a
  screen and a blank page is not a beta.

## 2. The layout

**Frontend.** v1 stays exactly where it is; v2 is a new sibling that mirrors it.

```
frontend/src/components/
  <module>/                 v1 — not moved, not renamed
  <module>_v2/              v2 — e.g. project_logs_v2/ beside project_logs/
    pages/index.js          re-exports from lazy.js
    pages/lazy.js           React.lazy per page, webpackChunkName "<module>-v2-<page>"
    <area>/components/      v2's own screens (person_view/, approver_view/, … as v1 has)
    <area>/containers/      …V2Container.js, plus use*.js hooks
    <area>/logic/           v2's own reducer(s), when v2 has state of its own
    shared/  styles/  utils/
    constants.js  formValidations.js  index.js
  <Module>VersionRoute.js   the switch point (§3)
```

- **Names** carry a `V2` suffix where v1 has the same noun: page exports
  (`ProjectLogsV2Listing`), containers (`PersonLogsV2Container`), shared components.
- **Lazy pages** are what keep v1's users from downloading v2 at all: copy
  `project_logs_v2/pages/lazy.js`, one `lazy(() => import(/* webpackChunkName:
  "<module>-v2-<page>" */ …))` and a `Suspense` per page.
- **Redux:** v2's own state is ONE nested slice beside v1's in
  `frontend/src/reducers/index.js` — `projectLogsV2: combineReducers({ person, approver,
  review })` is the precedent. v2 may read v1's slices.
- **No v2 URLs and no second sidebar entry.** Both versions answer at v1's URLs.
  Project Logs started with `/project-logs-v2/…` and collapsed them into v1's
  (`b76d346edb`); its `ROUTE_URLS.PROJECT_LOGS_V2_LIST` is now the same string as
  `PROJECT_LOGS_LIST`, and the old `projectLogsV2` sidebar entry sits at
  `isVisible: false`. One URL per screen is what lets the switch flip in place and
  leaves every link, bookmark and sidebar entry working.
- **Strings and test ids:** `DISPLAY_STRINGS` in
  `frontend/src/common/constants/displayText.js` under the module's prefix (Project
  Logs v2's are the `PL_*` keys), and the module's test-id constants.

**Backend.** Most betas need none: v2 is a new screen over the same data.

```
apps/<app>/api/
  urls.py     path("v1/<module>/", include(….api.v1.urls, namespace="v1"))
              path("v2/<module>/", include(….api.v2.urls, namespace="v2"))
  v1/         unchanged contracts — v1's screens still call them
  v2/         __init__.py  urls.py (app_name = "v2")  views/
```

- An endpoint whose response or behaviour v2 needs **different** gets a twin under
  `api/v2/`; the v1 one keeps its contract. `apps/project_logs/api/v2/urls.py`
  (`reviewer/team-subteams/`) is the example, and `apps/competencies/api/{v1,v2,v3}/`
  the fullest one.
- Serializers, param validations, models and utils stay shared. A model change is
  additive — a new field with a default, a new model — so v1's reads are unaffected;
  migrations as usual.
- Tests follow the app's layout: flat `tests/` (project_logs) or `tests/v2/` where
  the app already splits by version (competencies). Files are named `*_test.py`, and
  `common.tests.GlobalTestRunner` is a plain `DiscoverRunner` (pattern `test*.py`), so
  a module runs **only if the package's `tests/__init__.py` imports its test class**.
  Six v2-era modules in `apps/project_logs/tests/` are never run for exactly this
  reason. Add the import.

## 3. One switch point

`frontend/src/components/LogsVersionRoute.js` is the model: a function that takes the
two pages and returns a route component rendering one of them, props passed through.
`routes.js` wraps every route of the feature in it:

```js
component={requireAuthentication(requireLogsVersion(ProjectLogsListing, ProjectLogsV2Listing))}
```

- Write `<Module>VersionRoute.js` beside it, the same shape —
  `require<Module>Version(V1Page, V2Page)` — with the version coming from the user's
  choice (§5) instead of `permissions[V2_PERMISSION_KEY]`. Do not change
  `LogsVersionRoute.js`: it is Project Logs' gate, not a helper.
- Wrap **every** route of the feature. A route left unwrapped drops a user who chose
  v1 into v2 (or the reverse) on the next screen.
- Reuse first: `ls frontend/src/components/*VersionRoute.js`. If an earlier beta left
  one that reads a stored choice, make it take the storage key as an argument and use
  it for both, rather than writing a second copy.
- No settings allowlist, no permission key, no `Config` slug. A beta the user can
  leave needs none of them.

## 4. The switch

- **Rendered by the switch point**, above whichever page it renders — so it sits in
  the same place in both versions, and v1 needs no edit to carry it.
- **Outside any approved design.** A ticket that also carries `Design` gets mockups
  without it: build the screens to them and put the switch above them. It is never a
  departure from the design.
- An MUI `Switch` in a `FormControlLabel`, labelled from `DISPLAY_STRINGS` so it says
  which version the user is on; checked means v2. Competencies' `LABELS.LEGACY_VIEW` /
  `LABELS.CURRENT_VIEW` ("Legacy View" / "Current View", `displayText.js`) is the house
  wording for the two states.
- A `data-testid` from the module's test-id constants — the cases select it by that.
- Flipping it sets state at the switch point and writes the choice (§5): the other
  version renders at the same URL, route params intact, no reload.
- It is an ordinary component under the frontend standards: styles in the module's
  styles file, PropTypes, a keyboard-operable control with a visible label.

## 5. Where the choice is kept

In the browser, per user — the pattern `project_logs_v2/person_view/utils/viewPrefs.js`
already uses for v2's view preferences:

- One `localStorage` key for the module (e.g. `<module>V2.version`) holding a map keyed
  by username (`localStorage.getItem('username')`), values `'v1'` / `'v2'`.
- **Missing or unrecognised means v2.** A user who never touched the switch is on the
  beta; the switch is the way back.
- **Read it when the switch point mounts** (`useState` with an initializer) — not on
  every render, and **not cached at module scope across users**. `viewPrefs.js`
  caches the username in a module variable for the life of the page, and logout never
  reloads it (`App.js` `afterLogout` pushes to the login route), so a copy of that
  cache hands the second person on a tab the first person's choice.
- `afterLogout` removes named keys only, so the choice survives a logout and login on
  the same browser. It does not follow the user to another browser — say so in the MR.

A choice that must follow the user across devices is a backend preference — a
per-person model with GET/PATCH, as `PersonWorkingDays` and
`apps/project_logs/api/v1/views/working_days.py` do. Only when the ticket asks for it:
it costs a model, a migration and an endpoint.

## 6. What v2 owns, and what it borrows

- **v2 owns its screens:** components, containers, hooks, styles, its slice, its own
  `constants.js` and `formValidations.js`.
- **v2 borrows v1's data layer** — actions, selectors, reducers' slices, utils, API
  helpers — by importing it from v1's directory, as 28 of Project Logs v2's files do.
  Do not copy it.
- **v1 imports nothing from v2.** Project Logs kept that without exception: only
  `routes.js`, `reducers/index.js`, `LogsVersionRoute.js` and `sidebarLinks.js` import
  v2. It is what lets v2 be deleted if the beta is abandoned.
- **A v1 file is edited only for an extension v2 cannot do without, and only
  backward-compatibly** — Project Logs v2 did it to seven files: an optional parameter
  with a default (`getLogsConfigList(queryData = {})`, `savePersonTasks(…, onError)`),
  a null guard. Every v1 call site keeps doing what it did. If v2 needs a v1 helper to
  behave *differently*, v2 gets its own copy.
- **Global wiring outside both directories is expected:** `routes.js`,
  `reducers/index.js`, `common/constants/{routes,apiUrls,displayText}.js`,
  `constants/actionTypes.js`.

## 7. Each phase's part

- **plan** — `approach` names v1's directory, the `<module>_v2/` files, the routes the
  switch point wraps, each v1 file v2 must extend (and how that stays backward
  compatible), any `api/v2/` twin, and where the choice is kept. The switch point and
  the switch are their own steps.
- **implement** — builds it in that order: v2's pages and screens, then the switch
  point, the switch and the routes as one commit. Names every touched v1 file in
  `summary`, with why.
- **testcases** — the criteria in v2; the switch both ways at the same URL; v1's main
  flow as a `regression` case against the base branch; the choice across a reload and
  a logout/login; a fresh user on v2, whose first step removes the stored choice (the
  harness carries storage between cases). Every other step reaches a version by
  clicking the switch. No second-account case: verify has one login, so `review`
  checks that in the code.
- **review** — reads every v1 file in `git diff --stat origin/<base>...HEAD`; anything
  but a backward-compatible extension is a `major`, and so is v1 importing v2, an
  unwrapped route, a v2 URL or sidebar entry, the storage key spelled twice, or a
  username cached instead of read when the choice is read or written (§5). v2's
  copies of v1's components are the requirement, not a duplication finding.
- **verify** — clicks the switch, never writes the stored choice; logs out through the
  app, never by clearing storage. The one exception is setup: before the fresh-user
  case it removes the stored choice's key, and only that key.
- **ui-evidence** — v1 through the switch and v2 of each changed screen, same viewport
  and data, and the switch in both states. Below the switch, v1 should match the base
  branch; the switch itself is new, and any other difference is v1 having changed.
- **mr** — the description says where v1 and v2 live, which routes the switch wraps,
  where the choice is kept and that it is per browser, the default, the v1 files v2
  extended, and how to retire v1 (§8).

## 8. Retiring v1 later

Write this into the MR, because the person who does it will not have read the ticket:

1. Point each wrapped route in `routes.js` straight at its v2 page, and delete
   `<Module>VersionRoute.js` (or drop the module from a shared one).
2. Move whatever v2 still imports from `<module>/` into `<module>_v2/` or `common/`,
   then delete `<module>/`.
3. Delete any `api/v1/` endpoint only v1's screens called, and its tests.
4. Leave the stored key: an orphaned `localStorage` entry is harmless, and removing
   it is not worth a migration of anyone's browser.

## Check before you finish

- [ ] `git diff --stat origin/<base>...HEAD` lists no v1 file except backward-compatible
      extensions, each named in `summary`.
- [ ] `grep -rn "_v2" frontend/src/components/<module>/` prints nothing.
- [ ] Every route of the feature is wrapped; no route, URL constant or sidebar entry of
      v2's own was added.
- [ ] The switch is rendered by the switch point, labelled, keyboard-operable, with a
      test id, and flips without a reload.
- [ ] The choice is keyed by username, read on mount, and missing means v2.
- [ ] v2's pages are lazy with `<module>-v2-*` chunk names.
- [ ] Any backend test module you added is imported in its `tests/__init__.py`.

## Do not

- **Do not move or rename v1.** It stays at `<module>/`; v2 is the new sibling.
- **Do not gate the beta on a server allowlist or a permission**, the way Project Logs
  v2 is gated. The user must be able to choose, and a cohort in `settings.py` takes a
  deploy to change.
- **Do not give v2 its own URLs or sidebar entry.**
- **Do not write the stored choice from a test, a script or a verify session** — reach
  each version through the switch, or the switch is untested. Removing it before the
  fresh-user case is setup, not a way to a version.
- **Do not write a Jest test for the switch.** Jest is rotted here and CI does not run
  it; the Playwright cases `testcases` writes are the coverage.
