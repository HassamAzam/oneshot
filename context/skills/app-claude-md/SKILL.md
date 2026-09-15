---
name: app-claude-md
description: Maintain per-app knowledge in apps/<app>/CLAUDE.md files — capture non-obvious app knowledge into the router, and split a feature deep-dive into apps/<app>/claude_docs/<feature>.md when the file outgrows ~150 lines. Fires when the user wants to persist something learned about an app ("remember X about costing", "add this to the leaves CLAUDE.md"), or when an app-level CLAUDE.md needs splitting by feature. NOT for the root project CLAUDE.md/AGENTS.md or for skill/rules files — that prose quality is governed by claude-md-writing, which this skill calls into for how to write each section well.
version: 1.0.0
---

# App-Level CLAUDE.md Maintenance

This skill owns the **maintenance loop** for `apps/<app>/CLAUDE.md` files: capture non-obvious app knowledge, and split by feature when a file grows too large. It is the *orchestrator*; it consults [`claude-md-writing`](../claude-md-writing/SKILL.md) for the prose-quality rules (WHAT/WHY/HOW, no-linter's-job, write-for-attention, don't-restate-the-obvious). Apply those rules to every section you write here.

---

## Where Does This Fact Go? (decide before writing anything)

A new fact has four possible homes. Pick by **blast radius** — how widely is it relevant?

| The fact is about… | Home | Loads |
|--------------------|------|-------|
| A global convention, command, build step, or a **coordination between 2+ apps** | root `CLAUDE.md` (e.g. its `## Module Linkages`) | every session |
| **One app's internals** — its models, edge cases, debugging heuristics | `apps/<app>/CLAUDE.md` | when you work in that app |
| **One feature inside an app**, and it's large/self-contained | `apps/<app>/claude_docs/<feature>.md` | when that feature is the topic |
| **Ibrahim-specific**, not team-shared | personal memory (`~/.claude/.../memory/`) | recall only |

**Tiebreak for cross-app facts (prevents duplication):** a cross-app interaction is recorded at **root in one line** — *that the linkage exists* (e.g. "Payroll ↔ Costing: `CurrencyRate` is the conversion source of truth"). The **mechanics of how it works** live in the app that owns the logic (`apps/costing/CLAUDE.md` explains how the conversion is applied). One-line pointer up top, full detail in the owning app — never the full explanation in both.

Only facts in rows 2–3 are this skill's job. Row 1 → `claude-md-writing`. Row 4 → your memory triage.

---

## Why App-Level Files Exist (the loading mechanic)

Claude Code loads memory by directory:

- The **root** `CLAUDE.md` / `AGENTS.md` load at startup, every session.
- A **nested** `apps/<app>/CLAUDE.md` loads **on-demand — only when Claude touches a file under `apps/<app>/`.** It is *not* in context while you work in another app.

So an app `CLAUDE.md` is already progressive disclosure by directory. That is exactly what you want — but it has one sharp edge: **the whole file loads the moment you touch any file in the app.** A 260-line app file dumps all 260 lines into context even when you're editing an unrelated util in that app. That single fact drives the entire splitting rule below.

---

## Routing — Is This Skill the Right One?

| File being changed | Skill |
|--------------------|-------|
| `apps/<app>/CLAUDE.md` — capture knowledge / split by feature | **this skill** (`app-claude-md`) |
| `apps/<app>/claude_docs/<feature>.md` — a feature deep-dive | **this skill** (it creates and points to them) |
| Root `CLAUDE.md` / `AGENTS.md`, a `SKILL.md`, a `.claude/rules/*.md` | **`claude-md-writing`** |
| Writing the *prose* of any section in any of the above | **`claude-md-writing`** (this skill calls into it) |

If the work is "maintain what an app knows about itself," it's this skill. If it's "make this instruction text good," it's `claude-md-writing`.

---

## The Two Altitudes

| Altitude | File | Loads when | Holds |
|----------|------|-----------|-------|
| **App (router)** | `apps/<app>/CLAUDE.md` | You work anywhere in the app | The structural map — models, cross-module deps, app-wide debugging heuristics, data-integrity rules — **plus a pointer index** to the deep-dives. Kept under ~150 lines. |
| **Feature (deep-dive)** | `apps/<app>/claude_docs/<feature>.md` | A pointer pulls it in, only when *that feature* is the topic | One self-contained subject: bonus-costing math, pnl-report allocation, wfh rules. May be long — you only pay when relevant. |

Feature docs are **plain `.md` files, never named `CLAUDE.md`** — the `CLAUDE.md` name is reserved for files you genuinely want directory-auto-loaded (root + per-app). A plain name makes the "pointer-only, on-demand" contract explicit.

---

## Action 1 — Capture Knowledge (explicit + offer)

**Trigger:**
- **Explicit** — the user asks to persist something ("add this to costing's CLAUDE.md", "remember that …").
- **Offer** — after a non-trivial debug/trace/feature session in an app surfaces something non-obvious, *offer* to persist it: "I learned costing's December correction can go negative — persist that to `apps/costing/CLAUDE.md`?" **Never write unprompted.** These files are committed and team-shared; silent edits are not allowed.

**Capture only the non-obvious.** Yes to: edge cases, "looks wrong but is intentional", cross-module gotchas, debugging traces/heuristics, magic constants with business meaning (`BONUS_ACTUALIZATION_MONTH = 12`), data-integrity invariants. **No to:** restating model field lists, what a view does, anything greppable from the code in seconds. Restating the obvious is what bloats the file toward a needless split.

**Where it lands.** Use the shared section vocabulary so every app file is predictable:
`Core Models` · `Cross-Module Dependencies` · `Data Integrity Rules` · `Common Data Inconsistencies` · `Known Edge Cases` · `Debugging Heuristics`.

**Materialize sections on demand.** Create only the section the fact belongs to. No empty stubs, no `<!-- fill in -->` placeholder comments — a section appears when it has real content. If the app has no `CLAUDE.md` yet, bootstrap it: a one-line "what this app is" + the single section the fact belongs to. Let it grow organically.

---

## Action 2 — Split by Feature (when the router outgrows ~150 lines)

**Trigger:** an app `CLAUDE.md` crosses **~150 lines** (soft cap — a trigger to *look*, not a mandate to butcher a cohesive file to hit a number).

**Decide what moves with one test:**

> *"If I'm editing an unrelated file in this app, do I need this loaded?"*

- **No → extract.** Self-contained feature deep-dives (bonus math, a specific report's logic) fail the test — they're only relevant when that feature is the topic.
- **Yes → keep.** The structural map (models, cross-module deps, app-wide debugging heuristics, integrity rules) is relevant to *any* work in the app. **Never extract the structural map.**

**Procedure:**
1. Find the largest self-contained feature section that fails the test.
2. Move it verbatim to `apps/<app>/claude_docs/<feature>.md`. Give the new file a one-line opening: *"Read this before working on \<the feature / the symptoms it explains\>."* — that line becomes the pointer's trigger text.
3. Replace it in the router with a pointer row (format below).
4. Repeat until the router is back under ~150 lines.
5. Verify nothing was lost: every line of the old file is now either still in the router or in a `claude_docs/` file.

**Pointer index** in the app `CLAUDE.md` (mirrors the root file's `.claude/rules/` table — one idiom across the whole repo):

```markdown
## Feature Deep-Dives
| Topic | Read before working on |
|-------|------------------------|
| [Bonus costing](claude_docs/bonus_costing.md) | billable/non-billable bonus, indirect bonus pool, clientwise PnL `indirect_bonus` |
```

The right column is the *when-to-load* trigger, taken from the deep-dive's opening line.

---

## Workflow

1. **Identify the app** from the path or the user's request.
2. **Capture or split?** Knowledge to persist → Action 1. File over ~150 lines (or user asks to split) → Action 2.
3. **Write each section** per `claude-md-writing` rules — non-obvious only, imperative, no inline comments, no restating code.
4. **Report the delta** — before/after line count of the router, and where any extracted content now lives.
5. Never `git push` or commit unless the user asks (standing rule).

---

## Anti-Patterns to Flag

- ❌ Empty section stubs / `<!-- fill in -->` placeholders sitting in an app file.
- ❌ Feature deep-dives named `CLAUDE.md` instead of `claude_docs/<feature>.md`.
- ❌ Extracting the structural map (it's always relevant when in the app).
- ❌ Restating greppable code (model fields, what a view does) into the app file.
- ❌ Auto-writing captured knowledge without offering first.
- ❌ A feature directory created only to host a `CLAUDE.md` so it "auto-loads" — features aren't directories; use a pointer.
