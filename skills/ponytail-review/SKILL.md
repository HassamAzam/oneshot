---
name: ponytail-review
description: >
  Code review dimension focused on over-engineering. Finds what to shrink or
  replace with stdlib/native: reinvented standard library, unneeded dependencies,
  speculative abstractions. Complements correctness-focused review and
  dead-code-sweep — does NOT flag dead code (dead-code-sweep handles that).
  Outputs in the same {id, severity, file, line, what, why, fix} schema the
  review phase uses, so findings integrate into the structured findings.json.
---

# Ponytail Review — over-engineering sweep

Review the diff for unnecessary complexity. The diff's best outcome is getting shorter.

## Integration

You are one review dimension inside erp-code-review's orchestrated flow. Your findings
go into the SAME `findings` array as every other reviewer's, using the SAME schema:

```json
{
  "id": "F-XX",
  "severity": "minor|suggestion",
  "file": "repo-relative path",
  "line": 123,
  "what": "one-sentence defect description",
  "why": "concrete consequence: what breaks, what's wasted, what's duplicated",
  "fix": "the specific replacement or deletion"
}
```

Continue the id sequence from the highest existing finding id. Over-engineering findings
are `minor` when the bloat is measurable (extra dependency, duplicated stdlib, unnecessary
indirection in a hot path) and `suggestion` when it is stylistic (verbose but correct).
They are never `blocker` or `major` — those are for correctness. If you find a correctness
bug while reviewing for complexity, raise it as a normal finding with the appropriate
severity; do not drop it.

## What to flag

- `stdlib:` hand-rolled thing the standard library ships. Name the function.
- `native:` dependency or code doing what the platform already does. Name the feature.
- `yagni:` abstraction with one implementation, config nobody sets, layer with one caller.
- `shrink:` same logic, fewer lines. Show the shorter form in `fix`.

## What NOT to flag

- **Dead code, unused imports, unreachable branches** — `dead-code-sweep` already covers this. Do not duplicate its work.
- **Framework-mandated patterns** (Django serializers, ViewSets, Form classes) — these are how the framework works, not over-engineering.
- **A single assert-based self-check or smoke test** — that is the ponytail minimum, not bloat.

## Scoring

End with: `net: -<N> lines possible.` in your summary.

If nothing to cut: note `Lean already.` in summary and produce zero findings.
