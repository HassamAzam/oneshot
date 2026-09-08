---
name: dead-code-sweep
description: Diff-scoped dead code detection and removal for this ERP repo — finds unused imports, unreachable code, commented-out blocks, and orphaned functions/components left behind on the current branch, deletes them, then re-lints to confirm nothing broke. Trigger on "find dead code", "remove dead code", "clean up unused code", "dead code sweep", or before opening an MR when a branch touched code that may no longer be called.
version: 1.2.0
---

# Dead Code Sweep

Finds and removes dead code introduced or exposed by a **bounded diff** — never a whole-repo
sweep. `.claude/rules/backend-python.md` and `.claude/rules/frontend-style.md` already forbid dead
code and commented-out blocks, but nothing actively hunts it down; this skill is that procedure.

## Modes

- **Standalone** (default) — the user invoked this skill directly ("find dead code", "dead code
  sweep", pre-MR cleanup). Run the full procedure end to end: scope selection, detection,
  delegated deletion, re-lint, and — mode 3 only — commit + push.
- **Review-only** — `erp-code-review` dispatches this skill as one of its parallel checks. The
  caller has already resolved diff scope (uncommitted diff, branch diff, or MR diff) and hands it
  in directly, so **skip "Scope Selection" entirely** — there is no `AskUserQuestion` in this mode,
  and no mode 1/2/3 branching to pick. Run only the detection logic ("What counts as dead" through
  the cascading check), then stop: **do not delegate deletions to `backend-agent` /
  `frontend-agent`, do not re-lint, do not commit or push.** Emit findings per "Review-only output"
  below and return control to the caller — it folds them into its own aggregated report. Every
  other section of this file (Scope Selection, Procedure steps 5–7) applies to Standalone mode
  only.

## Scope Selection

Before computing anything, ask the user which diff to sweep — do not guess. Skip the question only
if the invocation already disambiguates it (an MR URL/ID was passed as an argument, or the user's
prompt explicitly names one of the three modes). Use `AskUserQuestion` with only **two** listed
options — do not add a third "MR link" option:

> Which diff should the dead-code sweep check?
> 1. **Current diff** — uncommitted changes + staged changes only
> 2. **Current branch** — every commit on this branch since it forked (not uncommitted changes)

`AskUserQuestion` always appends its own "Other" choice with a free-text box — that is the MR
entry point. To request an MR sweep, the user picks "Other" and types the MR URL/ID directly, in
the same round trip; don't add a redundant third labeled option that just duplicates what "Other"
already does, and don't spend a second `AskUserQuestion` call asking for the link separately.

- If the answer matches option 1 or 2, proceed as that mode.
- If the answer came through "Other", treat it as an attempted **Mode 3** input and try to resolve
  it as an MR URL/ID (see Mode 3, step 1). If it doesn't parse as a URL/ID, or resolution fails
  (MR not found, no access, wrong project), don't guess or silently fall back to another mode —
  tell the user what went wrong and ask again in plain text for a valid MR link. Repeat until you
  have one that resolves, or the user cancels.

Then compute file scope per mode. In every mode, only files in the resulting diff are candidates
for deletion — never widen to a full-repo sweep in this pass, that is a separate, much higher-risk
exercise.

### Mode 1 — Current diff (uncommitted + staged)

```bash
git diff --name-only            # unstaged
git diff --cached --name-only   # staged
```

Union of both lists. Deliberately ignores already-committed history on the branch, even if there
is a lot of it — this mode is for "what am I about to commit right now."

### Mode 2 — Current branch (all commits since fork)

```bash
git fetch origin dev stage master
git merge-base HEAD origin/dev origin/stage origin/master   # whichever the branch forked from
git diff <base>...HEAD --name-only
```

Use `.claude/rules/branching.md` to identify `<base>` if the fork point is ambiguous (e.g. branch
was cut from `stage`, not `dev`). This is commits only — if uncommitted work sits on top and should
also be swept, tell the user and offer mode 1 for that on-top diff, don't silently fold it in.

### Mode 3 — A specific MR link

The link itself arrives via the "Other" free-text answer to the Scope Selection question (see
above) — no separate prompt needed for the first attempt. If that value fails to resolve (doesn't
parse as a URL/ID, MR not found, no access), ask again in plain text — not another `AskUserQuestion`
call, since that tool requires 2+ mutually-exclusive options and isn't suited to free-form retry
input. Don't proceed to any git command until you have a link that resolves.

1. Resolve the MR's source and target branch:
   - If `mcp__gitlab` is available, fetch MR metadata (title, source branch, target branch) from
     the given URL/ID directly.
   - Otherwise ask the user for the source/target branch names — do not guess them from the URL,
     GitLab MR URLs don't encode branch names.
2. ```bash
   git fetch origin <target> <source>
   git diff origin/<target>...origin/<source> --name-only
   ```
3. Treat this exactly like mode 2 from here on (it's the same three-dot commits-only diff, just
   against another branch's tip instead of local `HEAD`) — including the same caveat: uncommitted
   local changes are not part of an MR and are never in scope for this mode.

**Mode 3 is the only mode that commits and pushes.** Once deletions are made and re-linted, this
mode commits them (`fix: remove dead code`) and pushes to the MR's source branch — see step 7 in
"Procedure". Modes 1 and 2 only ever leave local uncommitted changes.

## What counts as dead

1. **Unused imports** — read directly from tool output, do not hand-roll detection:
   - Backend: `flake8`/`pylint` output (`F401`, `unused-import`) per [`python-linting`](../python-linting/SKILL.md).
   - Frontend: `eslint` `no-unused-vars` output per [`react-frontend-standards`](../react-frontend-standards/SKILL.md).
   - **An unused import is a symptom, not just the disease.** Two equivalent triggers, same
     handling: (a) the import is still present in the file but nothing references it anymore, or
     (b) the user already deleted the import line themselves. Either way, find the function in this
     file that was the import's only consumer and check it against case 4 (orphaned
     functions/methods) — if that function has no callers anywhere in the repo either, its need for
     the import is gone because the function itself is dead. Remove the function, not just the
     import line; removing only the import and leaving a now-pointless function behind is not a
     complete fix.
2. **Unreachable code** — statements after an unconditional `return`/`raise`/`break`/`continue` in
   the same block (pylint `W0101` surfaces most of these).
3. **Commented-out code blocks** — `# ...` or `// ...` lines containing code rather than prose,
   already banned outright by the repo's comment rules.
4. **Orphaned functions / methods / components** — a function, class, or component touched in the
   diff that has zero callers anywhere in the repo (not just the diff). Confirm with a repo-wide
   grep for the symbol name, not just a diff-local check — a caller elsewhere in the codebase makes
   it live even if the diff didn't touch that caller.
5. **Orphaned files** — a file whose only exports have zero repo-wide references, and which is not
   wired into `hrdb/urls.py`, `frontend/src/routes.js`, or an `__init__.py`/index barrel.
6. **Cascading dead code** — removing a function's only caller can leave the function itself dead;
   removing that function can in turn leave its own imports or its own sole helper dead. This
   ripples in both directions and is easy to stop checking too early:
   - A diff that deletes the only call site of `helper()` makes `helper()` itself an orphan (case 4)
     even though the diff never touched `helper()`'s file.
   - Removing `helper()` can leave an import at the top of its file unused (case 1), or leave
     another function that only `helper()` called now orphaned too.
   - Treat this as a fixed-point sweep, not a single pass: after each deletion, re-check the file it
     lived in (and any file whose only reference to it is gone) for newly-orphaned imports/functions.
     Stop only when a full pass finds nothing new.
   - All of this belongs in the **same diff** as the change that triggered it — don't defer the
     cascade to a follow-up pass or a separate finding; the person's original edit and its
     downstream dead code should land together.

## Never auto-delete these — flag for manual review instead

- Anything under `**/migrations/`.
- Anything referenced only via string/dynamic lookup: `apps.get_model()`, `getattr(...)`,
  `reverse("name")`, Django URL names, Celery task names passed as strings, strategy-map keys
  (`.claude/rules/solid.md` Open/Closed pattern) — static grep will show zero callers even though
  the code is live.
- Model fields — dropping a field needs a migration (`.claude/rules/backend-django.md`), not a bare
  delete. Hand off to backend-agent instead of removing the field yourself.
- Anything only reachable from `factory_boy` factories, Django admin registration, or test fixtures
  referenced by string/trait rather than direct call.
- Anything where the diff and repo-wide grep disagree with each other (e.g. grep finds a caller in
  a file the diff doesn't show, or vice versa) — treat as ambiguous, not dead.

When in doubt, report it as a finding rather than deleting it.

## Procedure

Steps 1–4 run in **both** modes. Steps 5–8 are **Standalone only** — in Review-only mode, stop
after step 4 and go straight to "Review-only output".

1. Resolve the scope mode with the user (see "Scope Selection") and compute the file list for
   that mode; split changed files into backend (`.py`) and frontend (`.js`/`.jsx`/`.ts`/`.tsx`).
   In Review-only mode, use the file list the caller supplied instead of running Scope Selection.
2. **Re-check every candidate against the current working tree before acting on it, not against
   what the diff/grep implied a moment ago.** A candidate symbol may already be gone — the person
   removed it themselves in a later edit (a subsequent commit, or an uncommitted change) on this
   branch (including mid-cascade, once an earlier deletion in this same pass removes it as a side
   effect). If a `grep`/`git diff` hit no longer resolves to real code when you look at the file
   directly, drop it silently: no deletion, no report entry, no "already removed" noise. Only
   report or delete what still exists right now.
3. For each category in "What counts as dead", scan only within the diff-scoped files, but verify
   orphan status with a **repo-wide** grep before flagging as dead (case 4 above depends on this).
4. Apply the cascading check (case 6): after marking something dead, re-scan the file(s) it
   references or lives in for newly-orphaned imports/functions, and repeat until a pass finds
   nothing new. This can pull in files outside the original diff scope — that's expected; widen the
   candidate set to whatever the cascade touches, but still exclude anything matching the "never
   auto-delete" list below. Re-apply step 2 before each deletion in the loop, since an earlier
   deletion in the same cascade can remove a later candidate as a side effect.
5. **(Standalone only)** Delegate the actual deletions — do not edit `.py` or frontend files directly from this skill:
   - Backend deletions → `backend-agent` (runs `python-linting` after every change).
   - Frontend deletions → `frontend-agent` (runs `react-frontend-standards` after every change).
6. After deletions, re-run the relevant linter on every touched file. If a deletion introduces a
   new lint error (e.g. a now-unused variable one level up), fix it in the same pass or revert that
   specific deletion — don't leave the tree in a broken state.
7. **Commit and push only in mode 3 (MR link)** — modes 1 and 2 stop at step 6, leaving the
   deletions as local, uncommitted working-tree changes for the user to review and commit
   themselves, exactly like the rest of this skill's output.
   - If nothing was removed in this pass, skip this step entirely — no empty commit.
   - Guard first: refuse and flag to the user instead of pushing if the MR's source branch is
     `main`, `master`, `dev`, or `develop` — these are protected per the repo's branching rules and
     this skill never commits directly to them, MR or not.
   - Otherwise, stage only the files this pass actually touched (never `git add -A`/`.`), commit
     with `fix: remove dead code`, and push to `origin/<source>` (plain push, never `--force`).
   - Tell the user what was pushed and to which branch/MR before or as part of the final report —
     a push is a shared-state action and must be visible, not folded silently into "Removed".
8. **(Standalone only)** Report:
   - **Scope** — which mode was used (current diff / current branch / MR `<link>`) and the base or
     source/target it was diffed against.
   - **Removed** — `file:line`, what it was, one-line reason it was dead.
   - **Flagged, not removed** — `file:line` and why it was ambiguous (matches an exclusion above).
   - **Pushed** (mode 3 only, and only if step 7 ran) — the commit SHA and branch it landed on.

Do not silently drop anything from the report — an unlisted skip reads as "nothing else was dead"
when it may just not have been checked.

## Review-only output

Used only in Review-only mode, in place of steps 5–8. Every case detected in "What counts as dead"
(steps 1–4 of the Procedure) becomes a finding — never a deletion. Use the same finding format as
the other `erp-code-review` agents (`.claude/skills/erp-code-review/refs/severity-rules.md`):

```
[SEVERITY] <path>:<line> — <one-line problem>
  Fix: <concrete suggestion — e.g. "remove the unused import" or "delete this orphaned function">
```

- Severity is **SUGGESTION** for straightforward dead code (unused import, unreachable statement,
  orphaned function/file, commented-out block).
- Severity is **NITPICK** when the case is borderline enough that a human should sanity-check it
  even though it isn't excluded outright (e.g. an orphaned helper with only one non-obvious
  call site removed earlier in the same diff).
- Anything matching "Never auto-delete these" does **not** become a finding at this severity —
  surface it instead under the caller's `Missing / Cannot Verify` section (e.g. "possible dead
  code at `path:line`, but only reachable via `apps.get_model()` — needs manual confirmation").
- No `Removed`, `Flagged`, or `Pushed` sections, no scope-selection prompt, and no delegation to
  `backend-agent` / `frontend-agent` — this mode only ever returns findings text.
- If nothing is dead, return nothing (an empty findings list) rather than a "Clean" line — the
  caller's aggregation step treats silence as pass, per severity-rules.md's "Silence means pass".
