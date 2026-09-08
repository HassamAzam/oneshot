---
name: graphify-knowledge-graph
description: Use this skill for architecture overviews, transitive impact ("2-hop" callers), cross-module symbol dependencies, god-node discovery, and any question where `GRAPH_REPORT.md`'s pre-computed analysis beats re-deriving it with grep. This repo ships a pre-built graphify knowledge graph in `graphify-out/` (~65k nodes, ~170k edges, ~77 MB). For single-symbol lookups ("where is X defined", "who calls X once"), grep is usually faster — see the decision table below before invoking.
version: 1.1.0
---

# Graphify Knowledge Graph Skill

This repo ships a pre-built knowledge graph of the codebase in `graphify-out/`. It is **better than grep for some questions and worse for others**. The graph is strongest where the answer requires traversal, clustering, or pre-computed analysis. For one-shot symbol or string lookups, raw `grep`/`rg` is usually faster because `jq` against the 77 MB `graph.json` has a ~1-2s cold-read floor.

---

## Decision table — graphify vs grep

| Question shape | Use | Why |
|---|---|---|
| "Where is `<symbol>` defined?" (1 hit expected) | **grep** | ~0.3s vs ~1.3s. grep is precise on a `^def `/`^class ` anchor. |
| "Who calls `<symbol>`?" (single-hop) | **grep** | ~0.3s vs ~1.2s. grep finds raw call sites including mocks/patches the graph may miss. |
| "What modules import `apps/foo/utils.py`?" | **grep** | ~0.5s vs ~3.5s. File-level imports are textual. |
| **"2-hop / transitive impact of changing `<symbol>`"** | **graphify** | ~1.7s vs a fragile shell loop in ~5s. The only place graphify reliably beats grep on time *and* correctness. |
| **"What's the architecture of `<module>`?"** | **graphify** | `GRAPH_REPORT.md` already lists communities, god nodes, and surprises. Re-deriving this with grep takes minutes. |
| **"God nodes / hot spots in the codebase"** | **graphify** | Pre-computed centrality. No grep equivalent. |
| **"Show me the `<community>` cluster"** | **graphify** | Pre-computed Louvain communities. No grep equivalent. |
| **"Cross-module symbol-level deps (payroll→leaves at function level)"** | **graphify** | grep only finds file imports; graphify finds actual call/use edges. |
| String literal, SQL, error message, log line, settings key | **grep** | Graphify only indexes symbols. Labels may contain docstring text but it's unreliable. |
| Comments, TODO/FIXME, regex patterns | **grep** | Not in the graph. |

Rule of thumb: if you'd answer the question by running grep **once**, just run grep. If you'd need to chain greps or recurse, reach for graphify.

---

## Known limitations (read before trusting an answer)

- **`jq` cold-read floor is ~1.2-1.5s** on the 77 MB `graph.json`. Even a trivial query has this overhead — grep is faster for one-shot lookups.
- **53% of edges are INFERRED** (avg confidence 0.54, per `GRAPH_REPORT.md` Summary). Half the graph is heuristic, not AST-extracted. Treat low-confidence edges as hints, not facts — always confirm by reading the source file.
- **Labels are not always raw symbol names** — they may be docstrings or descriptive sentences. Search by `source_file` + `source_location` for precision; use `label` for fuzzy intent.
- **Tests are sometimes missed** as callers. graphify-extracted callers tend to undercount vs grep (graphify found 24 callers; grep found 31, including mocks/test-only references).
- **Frontend coverage may be partial** — check `GRAPH_REPORT.md`'s file count and the `repo` field on nodes before assuming JS/TS is fully indexed.
- **Staleness:** the graph snapshot reflects the commit listed in `.version` / `GRAPH_REPORT.md`. Local uncommitted edits are invisible until you run `graphify update .` locally.

---

## Step 0 — Verify the graph is present and fresh

```bash
ls graphify-out/                  # expect: graph.json, GRAPH_REPORT.md, manifest.json, .graphify_labels.json
cat graphify-out/.version          # expect: a 40-char SHA
```

If `graphify-out/` is missing or `.version` doesn't exist, tell the user to run `/get-graphify <branch>` (default: `master`). The bundle is in the GitLab Package Registry; pulling it is ~3 seconds.

If `.version` exists but the user is asking about very recent code that landed in the last few minutes, the graph may be stale by one or two commits — note it and proceed anyway. The pipeline rebuilds the graph automatically on every push to `dev`/`stage`/`master`, usually within ~3 minutes.

---

## Step 1 — Read `GRAPH_REPORT.md` first

`graphify-out/GRAPH_REPORT.md` is ~800 KB but the most useful sections are near the top:

- **Summary** — node / edge / community counts and freshness commit
- **Community Hubs** — clickable index of the major communities (each is a cluster of tightly-coupled symbols, like "the payroll module" or "the leave-encashment cluster")
- **God Nodes** — the most centrally-connected symbols (highest degree). Touching one of these has wide blast radius.
- **Surprises** — unexpected dependencies the graph found (e.g. payroll importing from invoices when you wouldn't expect it).

For any architecture question, **read the relevant Community Hub section in GRAPH_REPORT.md** before grepping. It already lists the symbols you'd otherwise have to find by hand.

```bash
# Quick way to navigate to a community
grep -n "^## " graphify-out/GRAPH_REPORT.md | head -40
# Then read that section
sed -n '<line>,<line+200>p' graphify-out/GRAPH_REPORT.md
```

---

## Step 2 — Query `graph.json` for symbol-level lookups

`graphify-out/graph.json` is the full graph. Schema:

```json
{
  "directed": true,
  "multigraph": false,
  "graph": {...},
  "nodes": [
    {"id": "<unique>", "label": "<symbol_name>", "source_file": "<rel/path.py>",
     "source_location": "L<line>", "community": <int>, "repo": "<top-level dir>"}
  ],
  "links": [
    {"source": "<node_id>", "target": "<node_id>", "relation": "<kind>",
     "confidence": <float>, "source_file": "...", "source_location": "..."}
  ]
}
```

Use `jq` for queries — far faster than parsing in your head:

```bash
# What does a node look like?
jq '.nodes[] | select(.label == "calc_salary")' graphify-out/graph.json

# All nodes from the payroll module
jq '.nodes[] | select(.source_file | startswith("apps/payroll/")) | {label, source_file}' graphify-out/graph.json

# All edges pointing AT a particular node (callers / users of it)
jq --arg target "<node_id>" '.links[] | select(.target == $target)' graphify-out/graph.json

# All edges from one module to another (cross-module dependencies)
jq '
  .nodes as $nodes
  | (.nodes | map({key: .id, value: .source_file}) | from_entries) as $file_of
  | .links[]
  | select(($file_of[.source] | startswith("apps/payroll/")) and
           ($file_of[.target] | startswith("apps/leaves/")))
' graphify-out/graph.json
```

If the graphify CLI is installed locally (it's usually NOT on dev laptops — only on the pipeline server), it has nicer query commands like `graphify query "..."` and `graphify path "A" "B"`. Don't assume it's available — fall back to `jq` queries against `graph.json`.

---

## Step 3 — When to fall back to grep

`graphify-out/graph.json` only knows about **symbols** the AST parser extracted: functions, classes, methods, imports. Use raw grep instead when the question involves:

- String literals (SQL queries, error messages, log lines, regex patterns).
- Settings keys, env-var names, feature-flag identifiers.
- Comments, docstrings, TODO/FIXME markers.
- Migration file contents (graphify treats migrations as AST but their semantic meaning is in the operations, which grep handles better).
- Frontend-only logic at the JSX/CSS layer if `graphify-out/` was built without those (check `GRAPH_REPORT.md`'s file count).

---

## Step 4 — How to report findings

When citing nodes from the graph, use the format:

```
`<label>` (`<source_file>:<source_location>`)
```

Example:

> The hot path is `calculate_salary` (`apps/payroll/utils.py:L142`), which the graph shows is called from 18 different modules — most prominently `apps/leaves/services.py` and `apps/costing/views.py`.

This makes citations clickable and verifiable.

---

## Refreshing the graph

`graphify-out/` is gitignored — it's per-laptop, never committed. To pull the latest:

```bash
/get-graphify master         # or dev | stage
```

This is hash-checked, so a no-op when the local copy already matches the latest published bundle. Typical fresh-pull is ~2–5 seconds.

If you've changed code locally and want the graph to reflect those changes immediately without waiting for the pipeline, install graphify locally (`uv tool install graphifyy`) and run `graphify update .` — that's AST-only, no API cost.

---

## Real-world workflows during coding sessions

Concrete recipes for the situations where the graph actually pays off in day-to-day work. Each is a verified `jq` snippet — copy, replace the target symbol/file, run.

### A. Bug investigation — "this function blew up in prod, what else uses it?"

Find the caller surface, grouped by file so you see which modules are most exposed:

```bash
jq -r --arg t "<node_id>" '
  (.nodes | map({key: .id, value: .source_file}) | from_entries) as $file_of
  | [.links[] | select(.target == $t) | $file_of[.source]]
  | group_by(.) | map({file: .[0], hits: length})
  | sort_by(-.hits)[] | "\(.hits)x \(.file)"
' graphify-out/graph.json
```

Output looks like `4x apps/teams/api/serializers.py` — instantly tells you which file is the biggest consumer. Faster than running `grep | sort | uniq -c | sort -rn` against the whole repo when the function is widely used.

### B. Pre-refactor blast radius — "I want to rename / change the signature of X"

Run the **2-hop transitive callers** recipe (in "Getting the most out") to get unique source files affected. If the count is small (<10), proceed; if it sprawls, plan a phased rename.

### C. Onboarding to an unfamiliar module — "I've never touched payroll, where do I start?"

1. `grep -n "^### Community" graphify-out/GRAPH_REPORT.md | head -20` — list communities.
2. Find the community that maps to the module (read the community section's symbol list).
3. Identify god nodes in that community — those are the must-read files before you change anything.
4. Skim "Surprises" in the report for non-obvious dependencies. This is where the report saves you from breaking a hidden contract.

### D. DRY check before writing a new helper — "is there already a util for this?"

Cluster-search by intent, not exact name. The graph groups related helpers in the same community:

```bash
jq -r --arg label "calculate_allowance" '
  [.nodes[] | select(.label | test($label; "i"))] as $seeds
  | $seeds[0].community as $c
  | .nodes[] | select(.community == $c) | "\(.source_file):\(.source_location) — \(.label)"
' graphify-out/graph.json
```

Returns every symbol in the same Louvain cluster — usually the existing helper you'd otherwise re-implement. Pairs well with the `util-reuse-methodology` skill.

### E. Finding code snippets — "where's the function that does X?"

Two-step:
1. `jq -r '.nodes[] | select(.label | test("<keyword>"; "i")) | "\(.source_file):\(.source_location) — \(.label)"' graphify-out/graph.json | head -20` — fuzzy intent search across docstrings + function names.
2. Open the top hit with Read at the cited line.

This beats grep when you don't know the exact function name — graph labels include docstring text, so you can search by purpose ("calculate", "format", "validate") rather than identifier.

### F. MR / diff review — "what does this changeset transitively touch?"

For each changed function `<f>`, run the bug-investigation recipe (A) above. Aggregate the unique files across all changed symbols. If any sit in a different community from the diff, that's where reviewers should look hardest — the change is leaking across cluster boundaries.

### G. API → DB code path tracing

Start from a view function node; follow outgoing edges through serializer → model. graphify catches the import/use links grep can only approximate:

```bash
jq -r --arg src "<view_node_id>" '
  (.nodes | map({key: .id, value: .source_file}) | from_entries) as $file_of
  | .links[] | select(.source == $src) | "\($file_of[.target]) — \(.relation)"
' graphify-out/graph.json | sort -u
```

### Known weak spots for these workflows

- **Django signals** (`post_save`, `pre_delete`, etc.) — receivers appear as standalone nodes but the *signal→handler* link is not always extracted. For signal-driven bugs, grep for `@receiver` and `connect(` directly.
- **Dynamic dispatch** (getattr, decorators that swap callables, `as_view()` registrations) — the graph misses these. Confirm by reading.
- **Frontend JS** — coverage may be lower than Python; check `repo` field on nodes before trusting a "no callers" result.

---

## Getting the most out of graphify

These are the patterns where the graph pays off — and how to extract that value.

### 1. Read `GRAPH_REPORT.md` first for architecture questions

Before grepping for "what's in module X" or "what are the major clusters", open the report. Communities and god-nodes are pre-computed — re-deriving them from grep takes minutes and is approximate.

```bash
# Jump to a community section
grep -n "^### Community" graphify-out/GRAPH_REPORT.md | head -20
# Read the section
sed -n '<line>,<line+150>p' graphify-out/GRAPH_REPORT.md
```

### 2. Use it for 2-hop+ traversal, not 1-hop lookups

Single-hop "who calls X" — grep wins (~3.5× faster). Multi-hop "if I change X, what's the blast radius two layers deep" — graphify wins (~3× faster) and is correct. Reach for it when you'd otherwise need to chain greps.

```bash
# 2-hop transitive callers of a function
jq -r --arg t "<node_id>" '
  (.nodes | map({key: .id, value: .source_file}) | from_entries) as $file_of
  | [.links[] | select(.target == $t) | .source] as $hop1
  | [.links[] | select(.target as $tg | $hop1 | index($tg)) | .source] as $hop2
  | ($hop1 + $hop2) | unique | map($file_of[.] // "?") | unique[]
' graphify-out/graph.json
```

### 3. Combine graphify (find the symbols) with grep (read the code)

Use jq to identify candidate symbols, then grep/Read to confirm. The graph is a fast index; it's not a substitute for reading the actual function. This also keeps you honest about INFERRED edges — verify by opening the file.

### 4. Cache common queries as shell aliases

The 77 MB JSON parses on every `jq` invocation. If you find yourself running the same callers-of-X or community-X query repeatedly, drop a script into `scripts/` so you don't retype the jq filter (and don't keep paying the cold-read).

### 5. Use `community` to navigate clusters

Every node has a `community` field. To find everything in the same cluster as a given symbol:

```bash
jq --arg label "<symbol>" '
  (.nodes[] | select(.label | test($label))) as $seed
  | .nodes[] | select(.community == $seed.community)
  | {label, source_file, source_location}
' graphify-out/graph.json
```

This is the easiest way to discover "what else lives with X" without grepping for related names.

### 6. Refresh proactively

`/get-graphify <branch>` is hash-checked and ~3s when up-to-date. Run it before deep architecture work so you're not analyzing yesterday's graph.

### 7. Don't blindly trust INFERRED edges

When an edge matters (e.g. deciding whether to refactor), check `confidence` — `EXTRACTED` is AST-derived, `INFERRED` is a heuristic guess. Open the source file at the cited location to confirm.

---

## Hard rules

- **For multi-hop / architecture / community / god-node questions, check `GRAPH_REPORT.md` and `graph.json` before grepping.** That's where the graph beats grep.
- **For single-symbol "where is X" or "who calls X once" questions, just grep.** Don't pay the 1-2s jq tax for a query grep answers in 0.3s.
- **Never paste large chunks of `graph.json` into your response.** Filter with `jq` and report only labels + source locations.
- **Always cite source file + line** when reporting from the graph (using the format in Step 4).
- **Never commit `graphify-out/`.** It's gitignored; if you ever see it in `git status`, flag it to the user — something is wrong with the local `.gitignore`.
