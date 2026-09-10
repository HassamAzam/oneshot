# Handover prompt

Paste everything below the line into a fresh Claude Code session started in
`~/Documents/oneshot`. It assumes nothing from the session that wrote it.

Edit the two bracketed lines at the end before handing it over: they are the only
parts that go stale.

---

You are picking up Oneshot, an unattended pipeline that drives a GitLab ticket
from a `Loop` label to `merged`. It ENDS AT THE MERGE — there is no deploy, no
QA against a running build and no demo; those phases were removed. Read this
whole brief before you touch anything.

## The shape of it

`~/Documents/oneshot` is the harness. `src/index.ts` and `src/conductor/*` are a
deterministic TypeScript state machine — it schedules, validates, retries and
reaps, and a model only ever runs *inside* a phase. Each phase is one fresh Agent
SDK session with a prompt from `src/phases/prompts.ts`, a model tier from
`config/models.json`, and a turn cap and timeout from `config/phases.json`.

It works on `arbisoft/workstreamai`, a **mirror** used as the evaluation bench.
The real repo, `arbisoft/erp`, is read-only context. The app under test is a
Django + React ERP; `~/Documents/workstreamai` is the checkout, and phases run in
git worktrees under `~/Documents/oneshot-wt/`.

State lives in `state/`: `oneshot.db` (sqlite: runs, phase_runs, quota_usage,
events), `state/runs/<iid>/run.json` (the journal), per-phase artifacts, and
transcript copies. **Timestamped** transcripts live in
`~/.claude/projects/<cwd-slug>/<sessionId>.jsonl` — the copies under `state/` have
no timestamps, so any timing question has to go to the `~/.claude` copy.

## What is true right now, and what is not

Sixteen runs exist; one reached `done`. A 2026-09-10 forensic review, verified by
adversarial refutation, found: **in sixteen runs, not one failure was the model
writing bad code that got through.** The architecture is sound. What breaks is the
environment layer around it.

Do not trust these documents without checking them against the code:

- `README.md` says "zero human gates". `config/project.json` has
  `reviewAllRuns: true`, so every run currently parks for a human plan approval.
- `README.md`'s pipeline table lists model tiers that PR #4 changed.
- `docs/gates/` is a large design set (54 findings) that was mostly not built.
  Treat it as history, not as a plan.
- `docs/FIX-PLAN.md` is broadly right but its **ordering is superseded** by the
  plan below.

## The five things that actually cost time

Each is measured, not guessed.

1. **A broken hook path, not the model.** `.claude/settings.json` in the work repo
   registers a `SubagentStop` hook by the relative path
   `python3 .claude/scripts/migration_check_hook.py`. The parent moves the shell
   cwd with `cd`, so the path misses, Python exits non-zero, and a non-zero exit
   is read as "you may not stop". Two subagents in run 24 each answered ~630
   stop-hook messages, burning 55.7 of that phase's 74.9 minutes.
2. **The coding agents have no `Edit` tool.** `backend-agent` and `frontend-agent`
   declare `tools: Read, Write, Bash`. Every change to an existing file is a
   whole-file rewrite: 163 writes and zero edits across all worktree subagent
   transcripts.
3. **Whole test suites re-run to answer a question they cannot answer.** Run 20
   spent 21.3 of 26.9 minutes on sixteen test invocations, five of them full
   309-test suites, to separate its own failures from twelve already broken on the
   base branch.
4. **Verify and ui-evidence rediscovered the app environment every run.** This is
   fixed by the harness below.
5. **The token ledger is roughly eighteen times low.** `src/conductor/phase.ts`
   records `msg.usage` — the main model's slice — and ignores `msg.modelUsage` on
   the same frame, which carries subagent spend. Every token number on the board
   is wrong in the same direction, and the budget guard is decorative.

## What was just built

**PR #10 — the browser harness.** `skills/local-browser-verify/scripts/harness.cjs`
plus a 46-module `modules.json`. One command brings the app up, logs in, and
navigates. Verified end to end: login 6.4s, home 1.2s, project-logs 3.9s.

```
node .claude/skills/local-browser-verify/scripts/harness.cjs smoke
```

Six environment facts it encodes, five of which were found by running it:

- The app is two processes and **you navigate to Django**. `hrdb/urls.py:93` is a
  catch-all serving the SPA for every route, so one origin answers for everything.
  Webpack only serves the bundle the template points at.
- **Use the hostname `localhost`.** `ALLOWED_HOSTS` has no bare IP, so
  `127.0.0.1` returns 400 from a healthy server. Django still binds to loopback.
- **Readiness is `static/webpack-stats.dev.json` reaching `"status":"done"`.** The
  file is written twice per compile; django-webpack-loader raises a bare 500 on
  anything else. A `Compiled successfully` from an earlier build stays in the log
  forever, so a log check reports ready while every navigation takes a 500.
- **Django runs `--noasgi`.** Under Channels' ASGI dev server a browser's
  keep-alive connections exhaust it, after which the process keeps its pid and its
  listening socket while answering nothing. This is the signature of run 18's
  four-hour verify wedge.
- **Websockets are blocked in the browser** — the other half of that wedge.
- **Login never uses `waitForURL`.** The app navigates with `history.push`, so the
  default wait cannot resolve. That stalled run 24's login.

**PR #11 — desk identity is its GitLab token.** The token both selects tickets and
does the work, so the two can no longer disagree: `GET /user` on this desk's token
gives the username, and the assignee gate uses it. `src/lib/token.ts` resolves the
token from the operator's own machine — `~/.config/oneshot/gitlab-token` (written
by `npm run token:set`), the keychain, `glab`, or `GITLAB_TOKEN` in `.env` last.
`~/.claude.json` is read only as a second opinion, to tell your own token apart
from a colleague's `.env` you inherited. The PR also excludes notes carrying an
`<!-- oneshot: -->` marker from the review gates, which is what let run 29 read
its own fleet's claim note as reviewer feedback.

Each operator needs a one-time step: a PAT with scope **`api`** (not `read_api`)
and Developer or above on the project. `npm run token:show` confirms who a desk
acts as.

## Do this, in this order

0. **Rotate four leaked secrets before any run.** A conductor-cwd phase read
   `.env` and four values are in two transcripts, one of which the board collector
   shipped: `GITLAB_TOKEN`, `GITLAB_READ_TOKEN`, `SLACK_BOT_TOKEN`,
   `LANGFUSE_SECRET_KEY`. Also add a read guard on `**/.env*` and give
   `state/PAUSE-DEPLOY` a scope and an expiry — it is a fleet-wide kill switch
   with neither, and it killed phases in five unrelated tickets over 13 hours.
   Two more files hold plaintext credentials written by past phases:
   `state/runs/20/scripts/lib.cjs` and `state/runs/16/evidence-pack.cjs`.
1. **One MR in the ERP repo** (`~/Documents/erp/.claude`, pushed to GitLab, *not*
   to Oneshot). Anchor the hook path with `$CLAUDE_PROJECT_DIR`, add `Edit` to
   both coding agents' frontmatter, and correct `CLAUDE.md`, which names `ruff`
   and `pytest` and asserts a Jest job — CI actually runs pylint, flake8 and
   `manage.py test`, and there is no Jest job. Under an hour; takes implement from
   75-85 minutes to roughly 18 on affected runs.
2. **Make verify a real gate.** `VERIFY_SCHEMA` has no verdict field and the phase
   counts as ok whenever nothing is `blocked`, so failures sail past and `merge`
   refuses three phases later on the bare string `fail`. Add a verdict and a
   per-case regression flag, refuse only on those, and fire the cycle before the
   ui-evidence/mr group. All seven case ids that have ever blocked a merge were
   non-regressions; two were verify's own Playwright timeouts.
3. **Wire the harness in**: lease a second port for webpack, have the conductor
   own the server across the verify→ui-evidence window, and rewrite those two
   prompt blocks to call the harness instead of describing a bring-up.
4. **Classify environment faults as parked, not blocked.** Probe the credential
   before spawning. Six 0.1-minute `error_max_turns` rows with zero tokens are one
   expired OAuth token, and the quota-park has never fired once.
5. **Set `reviewAllRuns: false`.** The plan gate has been asked five times,
   answered twice with a bare "approved", caught zero defects, and parked runs for
   23-29 hours each. Keep the human merge gate.
6. **Three board additions only**: case-level results, gate wait time, and
   per-session timing computed from the `~/.claude` transcripts.

**Skip, deliberately:** the `docs/gates/` confidence model, the eval framework,
the git-guard argv hardening, the SDK upgrade, further model-tier tuning, and
raising any turn cap.

## House rules

- **Where things live.** Skeleton skills describing this pipeline stay in
  `skills/` here on GitHub. Team skill enhancements, agents and rules go to
  `~/Documents/erp/.claude` on GitLab. `src/lib/claudedir.ts` composes both.
  Note that in a worktree the **work repo's** tracked `.claude` wins wholesale, so
  the documented "context repo first" rule does not apply where coding phases run.
- **Never `npm install` inside a worktree.** `node_modules` and `venv` are
  symlinks into a shared checkout.
- Never print a secret. Pass env var *names*.
- Verify before you believe a document. Several are stale in ways that matter.

## Useful tools left behind

Two scripts that make timing questions answerable. Copy them somewhere durable if
you want them.

```
python3 <scratch>/phase_timeline.py <run-dir> [phase] [--full]
python3 <scratch>/session_digest.py <sessionId> --tools
```

The first attributes a phase's wall clock across tool calls versus model time; the
second makes a large transcript readable.

---

[ CURRENT TASK: ................................................................ ]

[ OPEN PRs: #10 browser harness, #11 desk identity — both need review ]
