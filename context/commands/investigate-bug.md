---
description: Investigate a production bug report by checking the code path for edge cases and loopholes before touching prod data.
model: claude-opus-4-7
---

<!--
Model rationale: This command does heavy reasoning work — tracing multi-file code
paths, identifying subtle loopholes (race conditions, signal bypasses, cross-module
leaks), weighing fix tradeoffs, and checking module linkages. These are the judgment
calls Opus 4.6 handles best. A shallow analysis here means a wrong fix downstream,
so the cost of a strongexr model is worth it.
-->


# Investigate Bug

You are helping investigate a production bug. The user's workflow explicitly requires verifying the code is correct **before** any prod data is pulled — fetching prod data is discouraged and only happens after the code has been cleared.

## Input

The user will provide a bug report. It may be a GitLab issue link, an issue ID, a description, or pasted ticket text.

If it's a GitLab issue link or ID, fetch the issue details via the GitLab MCP (`mcp__gitlab-mcp__*`) before proceeding. Otherwise work from the description provided.

## Your Task

Walk through the code path and determine whether the bug is plausibly a code-level issue. Do NOT suggest pulling prod data in this step.

### Steps

1. **Identify the affected module(s).** From the bug report, determine which Django app(s) are involved (e.g., `apps/leaves`, `apps/payroll`, `apps/expenses`). Read the app-level `CLAUDE.md` if one exists — it contains data integrity rules and known edge cases for that module.

2. **Map the code path.** Find the relevant views, serializers, services, models, signals, and tasks. Trace the flow from entry point to database write. Use Grep and Read — don't spawn an Explore agent unless the bug is vague and you've already tried direct search.

   > **Graphify hint:** if `graphify-out/graph.json` exists, the `graphify-knowledge-graph` skill's Workflow A (caller surface, file-grouped) on the failing function ranks consumer modules by exposure in one query — useful for picking which entry point to trace first. Workflow B (2-hop transitive callers) gives the full impact tree when you suspect the bug propagates upstream.

3. **Check for loopholes.** Specifically look for:
   - Missing validation in serializers or `Model.clean()`
   - Race conditions (missing `select_for_update`, non-atomic updates)
   - Signals that can fire out of order or be skipped
   - `bulk_create` / `bulk_update` bypassing `save()` and signals
   - Direct `.update()` calls bypassing `save()` and signals
   - Missing permission checks
   - Edge cases in date/fiscal year handling
   - Null/empty handling gaps
   - **Nullable FKs used as lookup/join keys.** When a report or task does `dict(.values_list("foo_id", ...))` or `Model.objects.filter(foo_id__in=...)` on a `null=True` FK, every NULL row silently misses. This is a top failure mode for "report comes back empty" bugs — check it before theorizing about churn or rotation.
   - Cross-module assumptions that may not hold (see module linkages in root `CLAUDE.md`)

4. **Trace the creation path.** This is mandatory — always answer: *how could the bad data or bad state have been produced in the first place?* The crash site is rarely the origin. Specifically:
   - Find every code path that can write to the affected model (views, serializers, admin, management commands, Celery tasks, signals, bulk imports, hirestream/external syncs)
   - **For every writer, confirm whether it populates the field being relied on.** If the bug centers on a lookup that fails, the most likely cause is that the field is `NULL` because the writer never set it — not that it became stale. Grep each serializer's `Meta.fields`, each manager method's `.create()` kwargs, and any direct `.create()` calls. A field that "exists on the model" is not the same as "always populated."
   - **Read the model's migration history for the specific field.** Names like `0XXX_add_<field>_back.py`, `populate_<field>.py`, or `remove_<field>.py` are smoking guns that the field has been jostled. Read the data-migration `RunPython` carefully — the backfill's matching logic and exclusion rules often explain the current data quirks better than any theory about user behavior. Do this BEFORE forming hypotheses about churn.
   - Check git history for recent changes to those paths: `git log -S "<keyword>" --oneline -- <file>` to find when a specific pattern was introduced or changed
   - Ask: was there a code change that *exposed* pre-existing bad data (e.g., switching from an active-only manager to `all_objects`)? Or a code change that *started producing* bad data (e.g., replacing per-record saves with `bulk_create` without in-memory dedup, or removing a field-population step from a serializer)?
   - Consider: did an admin guard or iexact check exist before the data was created? If not, old records may predate the protection.
   - Report your conclusion: **is the bad state from old data exposed by a new code path, is it being actively produced by a current code path, or is the writer simply not populating a field that the reader assumes is populated?** This distinction determines whether a data migration is needed alongside the code fix and whether the writer also needs a fix.

5. **Check related modules.** If the bug involves a module with known cross-module dependencies (payroll, leaves, expenses, costing), verify the linkage logic. A bug in "leaves" may actually originate in how "payroll" reads leave data.

6. **Report findings.** Use this exact structure:

   ```
   ## Bug Investigation: <short description>

   **Affected module(s):** <apps>
   **Entry points:** <file:line references>

   ### Code Path
   <short trace from entry point to DB write>

   ### Verdict
   One of:
   - CODE LOOPHOLE FOUND — <description of the loophole with file:line>
   - CODE LOOKS CORRECT — no obvious loophole; next step is to verify prod data
   - AMBIGUOUS — <what's unclear, what would confirm it>

   ### Suspected Loopholes (if any)
   - <file:line> — <what's missing / wrong>

   ### Creation Path
   How the bad data/state was produced:
   - **Origin:** <old data exposed by new code | actively produced by current code path>
   - **Path:** <which entry point created the bad state — admin, form, sync, bulk import, etc.>
   - **Trigger:** <what code change exposed or introduced it, with commit reference if found>
   - **Data migration needed:** yes/no — <reason>

   ### Recommended Next Step
   - If LOOPHOLE: produce a fix plan (see next section), then ask the user which option to proceed with.
   - If CORRECT: run `/investigate-data` to pull prod data and look for manual-entry inconsistencies
   - If AMBIGUOUS: <specific question that needs answering before proceeding>

## Fix Planning (only if LOOPHOLE verdict)

Before writing any code or delegating to `backend-agent`, produce a structured fix plan. Do NOT skip straight to implementation.

### Steps

1. **Enumerate 2-3 fix options.** For a data integrity loophole, options typically fall into these categories — pick the 2-3 that actually apply:
   - **Defensive fix** — add validation at the layer where the bug leaks (serializer, `Model.clean()`, form)
   - **Root cause fix** — fix the actual mechanism that bypasses the rule (e.g., replace `bulk_update` with per-record `save()`, fix a signal, add `select_for_update`)
   - **Systemic fix** — add a DB-level constraint or check so the class of bug can never happen again (migration required)
   - **Hybrid** — combine a narrow defensive fix now with a systemic fix queued for later

2. **Check module linkages.** Read the root `CLAUDE.md` and the affected app-level `CLAUDE.md` files. If the loophole is in a module with known cross-dependencies (e.g., leaves ↔ payroll, expenses ↔ costing), trace whether the fix affects the linked modules. Flag any cross-module impact explicitly.

3. **For each option, fill in this card:**

   ```
   ### Option <N>: <short name>
   **Type:** defensive | root-cause | systemic | hybrid
   **Files touched:** <file:line references>
   **Change summary:** <1-2 sentences of what actually changes>
   **Side effects:**
     - Signals fired / skipped: <...>
     - Migrations required: yes/no (<reason>)
     - Cross-module impact: <none / which modules / why>
   **Test impact:** <which existing tests need updating, what new tests are needed>
   **Risk level:** low | medium | high — <why>
   **Backfill needed:** yes/no — <if yes, mention that /investigate-data + /fix-data will be needed after the code fix>
   ```

4. **Recommend one option** with 2-3 sentences explaining why it's the best tradeoff for this specific bug. Do not hedge — make a call. The user can override.

5. **Ask the user:** "Proceed with Option <N>, pick a different option, or modify the plan?"

6. **After user approves an option**, delegate to `planner-agent` for detailed implementation planning. Pass this as the input:

   ```
   Bug fix for: <short description>
   Loophole: <one sentence, file:line>
   Chosen approach: <option name from investigate-bug>
   Approach summary: <the "Change summary" from the chosen option card>
   Files involved: <file:line references from the option card>
   Side effects: <signals, migrations, cross-module impact from the option card>
   Backfill needed: <yes/no — if yes, /investigate-data + /fix-data after the code fix>
   Do NOT touch: <any files/modules that look related but shouldn't be modified>
   ```

   The `planner-agent` will do a reuse-first scan, produce a phased implementation plan, and stop for your explicit approval before any code is written. Once you approve the plan, `planner-agent` hands off to `backend-agent` for implementation.

### Rules for Fix Planning

- Do NOT write code yourself. The option enumeration is the deliverable of this command. Detailed planning is `planner-agent`'s job; implementation is `backend-agent`'s job.
- Do NOT skip the enumeration step even if one option seems obviously right — surfacing alternatives is the point.
- If you can only come up with one option, say so explicitly ("only one viable fix: <reason>") rather than padding with bad alternatives.
- If the fix crosses into `apps/auth/`, payments, or `common/permissions.py`, STOP and escalate to the user before planning further — those are in the no-touch list per root `CLAUDE.md`.
- If the loophole is in code that already has existing data corruption, the plan must mention that `/investigate-data` and `/fix-data` will be needed after the code fix lands, and in which order.
- After user picks an option, always delegate to `planner-agent` — never skip straight to `backend-agent`.

   ### Handoff Block (copy-paste into /investigate-data if starting a new session)
   ```
   Module: <app name>
   Models: <Model1, Model2>
   Suspected cause: <loophole description OR "manual entry suspected">
   Check for: <specific inconsistency rule to verify>
   Scope hint: <date range / person filter / fiscal year if known>
   Relevant CLAUDE.md rule: <quoted rule from app-level CLAUDE.md>
   ```
   ```

## Rules

- Do NOT write scripts to pull prod data in this command. That's `/investigate-data`.
- Do NOT propose fixes beyond the loophole you actually found. No opportunistic refactoring.
- Cite exact `file:line` references for every claim.
- If the bug report is too vague to map to code, ask the user for specific symptoms (which page, which action, which user role) before guessing.
- **Always trace the creation path** (Step 4 above) — never stop at the crash site. The origin of the bad data matters as much as the crash location.
