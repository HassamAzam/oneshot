# Fix plan — from the 2026-09-09 review

Ordered by what unblocks the next ten tickets, not by severity. Each item names the file,
the change, and what "done" looks like. Do them in order; do not start a design doc for any
of them.

## 0. Dead skill references — DONE 2026-09-09

`config/phases.json` named four skills no session could load (`ticket-recall`,
`ticket-research`, `test-case-writing`, `create-demo`). The `skills` field is rendered into
the prompt by `SKILL_LINE` (`src/phases/prompts.ts:61`), so every one of those phases opened
with a "Skills" section pointing at nothing and spent a turn finding out.

- `config/phases.json` — the four entries now carry `"skills": []`.
- `src/phases/prompts.ts` testcases — the eight brainstorm passes (the enum in
  `TESTCASES_SCHEMA`) are now written into the prompt itself, with the team's output shape
  and the oracle rule. The method no longer lives in a file that does not exist.
- `src/phases/prompts.ts` demo — the inline recording steps are the method; the "try the
  skill first" preamble is gone.
- `skills/ticket-memory-write/SKILL.md` — no longer names `ticket-recall`.

- `src/phases/prompts.ts` recall and memorize — the memory path is now the absolute
  `${STATE}/memory/`. Runs 8 and 16 show recall reading
  `~/Documents/erp/state/memory/index.jsonl` (the linked ERP CLAUDE.md anchors the model on
  that root), finding nothing, and returning empty: recall had never recalled anything.

Where skills live — the design says the ERP repo (`docs/PLAN.md`: "the source of all
skills"); the code is a split. `arbisoft/erp` `.claude/` is tracked (62 files, 27 skill
files on `origin/dev`) and supplies the team skills, agents, rules and CLAUDE.md.
`skills/` here holds the six pipeline-specific ones (`local-browser-verify`,
`ui-evidence-pack`, `demo-server-qa`, `mr-documentation`, `ticket-memory-write`,
`self-remediation`), added 2026-08-30 because conductor-cwd phases could not see the ERP
`.claude` at all (`src/lib/claudedir.ts` header). `ticket-recall`, `ticket-research` and
`test-case-writing` were never written in either repo — no branch of the ERP repo has ever
contained them.

**Decided 2026-09-09: keep the split.** Skeleton skills — the ones that describe THIS
pipeline (the six above, plus any future `test-case-writing` if it is ever written as a
file) — live in `skills/` here on GitHub. Team skills, agents, rules and every skill
ENHANCEMENT (planning, review, standards, test-case method if it moves into the team's
suite) go to the ERP repo's `.claude/` on GitLab. `claudedir.ts` composes both, ERP copy
wins on a name collision, so a name that appears on both sides means delete ours.

## 1. Make `verify` a real gate  (~half a day)

Today `VERIFY_SCHEMA` (`src/conductor/schemas.ts:182`) has per-case results and no verdict,
so a verify with failing cases finishes `ok`, the cycle back to `implement` never fires, and
`qualityGate()` (`src/conductor/codephases.ts:821`) refuses the merge three phases later.
Runs 21 and 24 both died this way. Run 24's three fails were pre-existing repo breakage.

1. Add `verdict: 'pass' | 'fail'` to `VERIFY_SCHEMA`, required. Mirror how `QA_SCHEMA`
   (`schemas.ts:256`) and the runner already treat qa's verdict: `fail` → the phase's
   `onFail: cycle`.
2. Give every failing case a `regression: boolean` with the same containment rule the qa
   prompt already carries (`prompts.ts:1277-1290`): a reproducible failure in behaviour the
   diff touched is a regression and fails the verdict; a failure in behaviour the diff never
   touched is recorded, goes to `followUps`, and does not fail the verdict. The check is
   mechanical: is the failing surface's file in `implement.filesChanged`?
3. `qualityGate()` then refuses only on `verdict: fail` or any `regression: true` case.
4. Done when: a verify with a regression cycles to implement in the journal, and a verify
   whose only fails are pre-existing reaches merge with those fails posted on the ticket.

## 2. Stop half the case list coming back `blocked`  (~1 day)

Run 20: 10 of 19 verify cases and 10 of 19 qa cases blocked. Causes are known:

- Frontend dev port is a fixed 3000 while `PORT_POOL` leases backend ports only, so two
  worktrees collide. `src/lib/worktrees.ts:143` `leasePortFor` — lease a frontend port too
  and pass both through `ONESHOT_PORT` / a new `ONESHOT_FE_PORT`.
- The pinned test account lacks admin groups features are gated behind. Provision the
  account once with the groups `HANDOFF.md` lists, and make `npm run preflight` assert them.
- Cases needing a mailbox, Celery control or OAuth cannot run anywhere the pipeline reaches.
  Add `requires: ('admin'|'mailbox'|'celery'|'oauth'|'none')[]` to each case in
  `TESTCASES_SCHEMA` and have verify/qa mark those `not-executable-here` up front instead
  of spending turns discovering it. This is the LLD's `surface` idea, cut to one field.
- Done when: a run's blocked count is under 3 of 19 for reasons the schema did not predict.

## 3. The Playwright harness  (~1.5 days, biggest token saving in the repo)

Verify is the top spender: 2M to 4M weighted per run at ~12 turns per case. The LLD
(`docs/gates/02-lld.md` Part 3 §2) designed `skills/local-browser-verify/scripts/harness.js`
and measured a 300→75 turn drop. Build only that:

- `harness.js` starts the app on the leased ports, logs in with the managed credential from
  env (never interpolated into the prompt), exposes `runCase(id, steps)` and screenshots.
- Shrink the verify prompt (`prompts.ts:836-955`, ~150 lines) to: call the harness, execute
  the list, fill the schema. Delete the three contradictory detach recipes (`:866`, `:884-889`,
  and the skill's `tail -f` one), the two credential sentences that disagree (`:892` vs
  `:896`), and the stale budget fallbacks (`:815`, `:967`).
- Done when: verify on a 20-case list finishes under 120 turns and under 1M weighted.

## 4. The board reads the quality artifacts  (~1 day)

The collector (`scripts/board/index.mjs:95`) reads `run.json` and transcripts only.
`verify.json`, `qa.json`, `findings.json`, `testcases.json` never reach the board or Langfuse.

- `scripts/board/extract.mjs` — emit two new row types: `case_results` (run, phase, case id,
  result, regression, requires) and `review_findings` (run, verdict, severity, file). Board
  ingest schema gains the two tables.
- `scripts/board/journal.mjs:40` — `parked` is not `running`; give it its own status so runs
  25 and 27 stop shipping as live forever.
- `testcasesApproval` in `gates.mjs:14` is a real key (`reviewgate.ts:228` writes it). It is
  absent from every journal only because no run has reached the testcases gate since gates
  went on for all runs. Not a bug; leave it.
- Record weighted spend on failed phase laps. 26 of 141 `phase_runs` have no `quota_usage`
  row, all failures, so retries look free. Write usage on the failure path in the runner.
- Pick ONE Langfuse exporter. Keep the collector's (`scripts/board/langfuse.mjs`, real span
  tree); delete the call at `src/conductor/runner.ts:1559` to `src/lib/langfuse.ts`. Both set
  the same session id with different trace ids, so every phase's tokens land twice.
- `hooks/log-event.cjs` — write `tool_use_id`; `scripts/board/hooks.mjs:41` matches Pre to
  Post by position and 1,337 orphans skew a third of durations.
- Done when: the board can show, per run, cases pass/fail/blocked and the review verdict.

## 5. Guards that hold under `bypassPermissions`  (~half a day)

- `hooks/git-guard.cjs:209` — rules apply only when argv[0] is literally `git`.
  `bash -c "git push"`, `/usr/bin/git`, `env git`, `xargs git` all pass. Normalise: strip
  `env`, `command`, `nohup`, absolute paths to basename, and recurse into `-c` strings for
  `bash|sh|zsh`. Any segment the parser cannot classify in a worktree phase → deny.
- `src/conductor/hooks.ts:61` — add `git-guard.cjs` and `write-scope.cjs` to `FAIL_CLOSED`.
  A guard that crashes must not become allow.
- `review` phase: `prompts.ts:805` says "you have no Write tool". Make it true, not deleted:
  the phase's artifact arrives by structured output (`phase.ts:407`), so set its `writes`
  to `[]` in `phases.json` and `toolPolicy` (`phase.ts:107`) will strip Write/Edit. Do the
  same for `testcases`, `plan`, `research`, `recall`. Only `implement`, `verify`,
  `ui-evidence`, `deploy`, `qa`, `demo`, `memorize`, `document`, `remediate` write files.
- Done when: `npm run hooks:verify` has a case for each bypass form above and it passes.

## 6. Test-case gate feedback writes real cases  (~2 hours)

`appendEdgeCases` (`src/conductor/reviewgate.ts:542`) turns each reply line into a case with
`expected: "Matches the QA-reported edge case: …"` and `blast: medium`. That is not an oracle.
Do what the plan gate does: re-run `testcases` with the feedback appended
(`reviewGateFeedbackBlock`), so the model writes the case with a real expected value and its
own blast. The list is still written once per approval round.

## 7. An eval loop for one phase  (~1 day, then ongoing)

This is how skills get tuned. Do not build a framework.

- `scripts/eval-phase.ts <phase> <iid>...` — replays one phase from a stored run directory
  with its prior artifacts fixed (the runner already hands off via `prior[]`), N times,
  writing each artifact to `state/evals/<phase>/<iid>/<n>.json`.
- A rubric per phase, written once, in `docs/rubrics/<phase>.md`. For testcases: every AC
  has a case; every `expected` is falsifiable without reading the code; hostile pass non-empty
  or explained; count of cases needing `requires` beyond `none`.
- A grader session applies the rubric and returns a score per artifact. Hand-rate 20
  artifacts once to check the grader agrees with you.
- Start with `testcases` (it is the oracle for two other phases), then `plan`.
- Use `anthropic-skills:skill-creator` evals / `claude plugin eval` for the run-and-compare
  loop rather than writing one.
- Done when: a change to the testcases prompt can be shown to move the rubric score on the
  same four inputs.

## 8. Durability, quick  (~2 hours)

- `src/lib/artifacts.ts:182` — temp file + rename for `run.json`. A crash mid-write loses
  the only resume source.
- Credentials are interpolated into prompt text at `prompts.ts:213-224`, `:254-262`,
  `:290-308`, `:479-494` and land in every transcript and on the board. Pass the env var
  name; the session reads it from `process.env` in Bash.
- `PAUSE-DEPLOY` halts the whole fleet (`hooks/_common.cjs:108`) and reports as quota.
  Make `pause-check` treat it as a deploy-only deny.

## Then

Run ten tickets. No new design documents until the board shows ten runs with case-level
results. The GitLab mirror project stays the evaluation bench; rebase its `dev` from the
real repo before each batch, and promote to the real repo only by a fresh MR through the
human merge gate that already exists.
