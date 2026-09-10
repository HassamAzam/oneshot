# Incident & root-cause log — run 237 `testcases` (2026-09-10)

**Status:** root cause found; fix in this branch. The run's ticket code is **not** at fault —
`implement`'s four commits sit clean on the branch and were never evaluated.

| Run | Ticket | Where it stopped | Root cause | Ticket code at fault? |
|-----|--------|------------------|------------|-----------------------|
| `r-mtvacbt9-7a23b5` | #237 Project Logs: importing Aug 31 also pulls September | `testcases` (blocked) | A turn budget inherited from when the phase ran *before* `implement`, spent entirely on re-deriving UI vocabulary that no upstream artifact supplied | **No** |

---

## 1. What the transcript actually shows

`testcases` ended `error_max_turns` at **40 turns in 224s of a 900s timeout** — the turn cap
bound, the clock was irrelevant, 11 minutes went unused. Across those 40 turns it emitted
**11,719 output tokens**. A finished case list is several times that, so the session never
began authoring: it was still reading when it died. `onFail: "abort"` turned that into a
blocked run, and because the phase writes nothing until its structured output, all 40 turns
(3.3M cache-read tokens, $2.43 of Opus) were thrown away.

Self-remediation diagnosed "cap too small" and could not act — `config/phases.json` is
write-denied to every phase — so the run stopped for a human.

## 2. Root cause 1 — a budget that never moved when the job changed

`maxTurns: 40 / timeoutMin: 15` is byte-identical to the value this phase was born with in
`37f3978`, when `testcases` was **`n: 3` and ran BEFORE `implement`**: author from the ticket,
the research and the plan, with no code to read.

`0d64e2d` ("write test cases after implement, not before") moved the block to `n: 4` verbatim
and, in the same commit, added to the prompt:

- `## What implement (phase 3) actually built` — a whole new artifact in context
- "Read `git diff origin/dev` **before you start**"
- "**Read whatever you need to.**", replacing the previous "Do not run anything."

The job roughly doubled; the budget did not move. Every other phase whose scope grew got a
measured raise with a `_why_turns` note — `verify` 200→300→450, `research` 60→120,
`document` 40→70. `testcases` was the only phase that changed job description without one.

## 3. Root cause 2 — why 40 held nine times and broke on this ticket

| run | turns | outcome |
|---|---|---|
| r-mtfu7n30 | 15 | ok |
| r-mtskclzs | 18 | ok |
| r-mth5odll / r-mtsgw8l5 | 23 | ok |
| r-mtfua4av | 24 | ok |
| r-mtrrmw8y | 26 | ok |
| r-mtfu7ph1 | 28 | ok — after a **15-minute timeout** on its first attempt |
| **r-mtvacbt9 (237)** | **40** | **failed** |

Diff size is not the driver: #237's diff is **9 files, 211 insertions, 18.5 KB** — small. What
drives the cost is **whether the diff carries the UI vocabulary the cases are written
against**:

- run #8 (26 turns, ok) changed `loginTestIds.js`, `displayText.js`, `Login.js` — the
  vocabulary was *inside the diff*.
- run #19 (18 turns, ok) was backend-only `utils.py` — the cases needed **no** UI vocabulary.
- run #237 was a date-maths fix in `logic/gitlab.js`, `commitWindow.js`, `importHelpers.js`,
  behind a browser modal. **Zero UI vocabulary in the diff.**

So it went digging. Turns 29–58 of the transcript are `routes.js` → `LogsVersionRoute.js` →
route constants → the `V2_PERMISSION_KEY` gate → `PL_*` DISPLAY_STRINGS → `PersonLogsModals`
→ `IntegrationItemListV2`'s confirm label. **None of those files are in the diff.**
`research.json` handed it a `codePath` that is entirely logic-layer (`gitlab.js:24` root
cause, `github.js:22` contrast) and a `blastRadius` naming modules, not screens.

**The structural defect: the prompt's only sanctioned source of UI vocabulary is the diff, and
for a logic-layer fix behind a screen the diff contains none of it.** Exploration cost is then
uncorrelated with diff size and effectively unbounded. Raising the cap alone would let #237
through and leave the next such ticket to dig the same hole with more turns.

Non-causal, ~6 turns: four hard tool errors — zsh `no matches found: --include=*.js` twice, a
relative `cd` after the shell's cwd had shifted, a relative Grep path that no longer resolved.
Even discounting all of them the session was 34 turns in with nothing written.

## 4. Root cause 3 — hitting the cap is total loss

`src/conductor/runner.ts` gates partial-artifact salvage on
`r.cfg.name === 'verify' || r.cfg.name === 'qa'`; those two prompts rewrite
`<phase>-partial.json` after every case. `testcases` had neither the instruction nor the
salvage, so a cap hit discards everything and `onFail: abort` blocks the run.

## 5. Fixes in this branch

1. **`config/phases.json`** — `testcases` `maxTurns` 40 → 110, `timeoutMin` 15 → 30, with a
   `_why_turns` note recording the inheritance so it is not silently copied again.
2. **`research.uiPath`** (schema + prompt) — research now emits the route, the clicks to the
   behaviour, the gate constant and the testid/label vocabulary with the files they live in,
   and `testcases` is pointed at that field instead of excavating. `reachable: false` is a
   valid answer for a change with no UI surface. This is what makes 110 a real ceiling rather
   than a bigger number in front of an unbounded search.
3. **`testcases-partial.json`** — the prompt gains the write-as-you-go protocol (plus batched
   reads, absolute paths, land-the-plane at ~60%), and the runner salvages a partial list of
   at least 5 cases instead of blocking. Below that floor there is nothing worth reviewing and
   blocking is the honest answer. In review mode the QA gate shows a salvaged list to a person,
   and its `summary` says outright that it is partial.

## 6. Still open

- Run `r-mtvacbt9-7a23b5` is still `blocked` at `testcases` and needs resuming from that phase
  once this lands.
- `verify`, `ui-evidence` and `qa` are not yet handed `uiPath`; they inherit the vocabulary
  indirectly, through the case steps. Worth revisiting if any of them shows the same dig.
