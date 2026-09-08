---
name: util-reuse-methodology
description: DRY / duplicate-helper detection methodology for this ERP repo — search patterns, overlap scoring, placement rules, and output format. Used by util-reuse-agent to find and flag duplicate utilities.
---

# Util Reuse Methodology

## Inputs

A list of candidate helpers, each formatted as:

```
- path: <file>
  line: <line>
  name: <function name>
  intent: <3-5 word summary of what it does>
  signature: <params and return shape>
  layer: backend | frontend
```

If intents are not provided, infer them from the function name and body.

## Step 1 — Search in priority order

> **Graphify shortcut:** if `graphify-out/graph.json` exists, run the `graphify-knowledge-graph` skill's Workflow D (DRY cluster check) on each candidate's intent keyword before the grep passes below. It returns every symbol Louvain-clustered with the candidate — usually the exact helper you'd duplicate. Then fall back to the priority list below for anything the cluster missed.

### Backend candidates

1. `common/**/*.py` — shared Django utilities live here
2. `apps/<same-app>/utils.py`
3. `apps/<same-app>/helpers.py`
4. `apps/<same-app>/managers.py` and `querysets.py` for DB helpers
5. `apps/<same-app>/permissions.py` for auth checks
6. Finally, a repo-wide `Grep` by behavior (distinctive string literals, regex patterns, magic constants, API endpoints, core verb + noun like `calculate.*hours` or `format.*duration`)

### Frontend candidates

1. `frontend/src/common/**` — shared helpers
2. `frontend/src/**/utils/**` — same-intent file names (`Grep` for `export const <name>`)
3. `frontend/src/**/constants.js` and `displayText.js` for constants/strings
4. `frontend/src/**/hooks/**` for reusable logic hooks
5. Finally, a repo-wide `Grep` by behavior

## Step 2 — Score each hit

For each candidate, find the closest existing function and classify:

- **≥ 80% overlap** → flag as duplicate. Suggest direct reuse.
- **50–80% overlap** → flag as "close". Suggest extending the existing util rather than creating a parallel one.
- **< 50% overlap** → not a duplicate. Do not flag.
- **No hit** → verify placement of the new util is correct:
  - Used by one module → `<module>/utils/` is fine
  - Used by multiple modules → belongs in `frontend/src/common/**` or `common/` (Django), not inside a single module
  - Single-use helper that will clearly never be reused → inline is fine, do not flag

## Step 3 — Cite precisely

Every finding must name:

- The new file:line of the duplicate helper
- The existing file:function that it overlaps with
- The overlap classification (duplicate / close)
- A concrete fix: "import and reuse X" or "extend X to handle the new case"

**Do not flag a duplicate without citing the specific existing file and function.** Vague "this might already exist" comments are worse than saying nothing.

## Step 4 — Output format (strict)

Return ONLY this block. No preamble, no summary, no praise.

```
## Util Reuse Review

[SUGGESTION] <new-file>:<line> — Duplicate of <existing-file>:<existing-fn>.
  Fix: import and reuse `<existing-fn>`. If this case isn't covered, extend the existing util rather than creating a parallel one.

[SUGGESTION] <new-file>:<line> — Close match to <existing-file>:<existing-fn> (~60% overlap).
  Fix: extend `<existing-fn>` to handle <the new case>, or document why a separate helper is warranted.

[NITPICK] <new-file>:<line> — New util placed in module scope but used by multiple modules.
  Fix: move to `frontend/src/common/utils/` (or `common/` for Django) so other modules can reuse it.
```

If no duplicates found:

```
## Util Reuse Review
Clean — no duplicate utilities found.
```

## Severity Rules

- **SUGGESTION** — duplicate or close match with concrete existing citation
- **NITPICK** — misplaced util (scope too narrow for reuse) without an existing duplicate
- Never **BLOCKER** — duplicate utils are a quality concern, not a safety concern

## Do NOT

- Do NOT flag a duplicate without naming the exact existing file and function.
- Do NOT review style, SOLID, perf, or security — that's the other reviewer agents.
- Do NOT rewrite code. Your output is advisory only.
- Do NOT flag framework-provided helpers as "duplicates" of custom code (e.g. `lodash.get` vs a hand-rolled getter — the hand-rolled one is the problem, not the duplicate).
- Do NOT flag test helpers as duplicates of production code or vice versa.
- Do NOT search `node_modules`, build artifacts, or migrations.
