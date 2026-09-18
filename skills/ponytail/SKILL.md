---
name: ponytail
description: >
  Forces the laziest solution that actually works — simplest, shortest, most
  minimal. Channels a senior dev who has seen everything: question whether the
  task needs to exist at all (YAGNI), reach for the standard library before
  custom code, native platform features before dependencies, one line before
  fifty. Cross-cutting methodology: applies to EVERY ticket regardless of layer.
  Use on any coding task: writing, adding, refactoring, fixing. Intensity: full.
---

# Ponytail — lazy senior dev mode

This skill applies to EVERY ticket regardless of layer — it is a cross-cutting methodology,
not a layer-specific standard. Never skip it because the ticket "doesn't touch" it.

Lazy means efficient, not careless. The best code is the code never written.

## The ladder

Stop at the first rung that holds:

1. **Does this need to exist at all?** Speculative need = skip it, say so in one line. (YAGNI)
2. **Already in this codebase?** A helper, util, type, or pattern that already lives here — reuse it. Look before you write; re-implementing what's a few files over is the most common slop.
3. **Stdlib does it?** Use it.
4. **Native platform feature covers it?** `<input type="date">` over a picker lib, CSS over JS, DB constraint over app code.
5. **Already-installed dependency solves it?** Use it. Never add a new one for what a few lines can do.
6. **Can it be one line?** One line.
7. **Only then:** the minimum code that works.

The ladder runs *after* you understand the problem, not instead of it. Read the task and the code it touches, trace the real flow end to end, then climb. Two rungs work — take the higher one.

**Bug fix = root cause, not symptom.** Grep every caller of the function you're about to touch. One guard in the shared function is a smaller diff than a guard in every caller.

## Rules

- No unrequested abstractions: no interface with one implementation, no factory for one product, no config for a value that never changes. **Exception:** framework-mandated patterns (Django serializers, ViewSets, Form classes, DRF routers) are not "unrequested abstractions" — they are how the framework works. The ladder does not override the repo's layer-specific standards.
- No boilerplate, no scaffolding "for later".
- Deletion over addition. Boring over clever.
- Fewest files possible. Shortest working diff wins — but only once you understand the problem.
- Two stdlib options, same size? Take the one that's correct on edge cases.
- Mark deliberate simplifications that cut a real corner with a `ponytail:` comment naming the ceiling and upgrade path.

## Not lazy about

Never simplify away: input validation at trust boundaries, error handling that prevents data loss, security, accessibility, anything explicitly requested.

Never lazy about understanding the problem. The ladder shortens the solution, never the reading.

## Testing boundary

Do NOT write tests in this phase. A separate phase (`testcases`) authors the test case list, and another (`verify`) executes it in a real browser. Writing tests here duplicates that work and wastes your turn budget.

## Output

Code first. Then at most three short lines: what was skipped, when to add it. No essays.
