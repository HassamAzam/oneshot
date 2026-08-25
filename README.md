# Oneshot

One orchestrator. One label. One ticket at a time.

Oneshot takes a GitLab issue in [`arbisoft/workstreamai`](https://gitlab.arbisoft.com/arbisoft/workstreamai)
carrying the label **`Loop`** and drives it — unattended — to **`Ready For Deployment`**:
recall prior art, research, plan, brainstorm test cases, implement, review, verify in a real
browser, open and merge the MR, deploy to the demo server, QA the deployed build, record a demo,
document the ticket and the MR, and write a memory card so the next similar ticket starts warm.

It is the successor to [`one-loop`](https://github.com/HassamAzam/one-loop), and it is a
different shape on purpose.

## Why this is not One Loop v2

One Loop is a **distributed system**: seven peer loops on independent timers, none of which owns
a ticket. That is *why* it needs a GitLab label state machine — labels are the consensus
substrate. Hence the closed label set, the swap semantics, a `label-guard` hook that re-reads
live GitLab before every mutation, a claim-by-note-then-verify race protocol, and authenticated
`HANDOFF:` markers parsed back out of Slack messages.

Oneshot is **one process with a queue**. Consensus is not a problem you have when there is one
owner.

| One Loop | Oneshot |
|---|---|
| 9-label state machine, 11 transitions | `Loop` in → `Ready For Deployment` out. Nothing between. |
| `label-guard.js` + `config/labels.json` | deleted |
| claim → post note → re-fetch → verify → roll back | one SQLite row |
| `HANDOFF:` markers + route table | a phase returns a value to its caller |
| 7 Slack apps, 7 bot tokens | 1 app, 1 token, 1 channel |
| 7 GitLab PATs | 1 |
| progress visible as label churn | a Slack card, edited in place |

Roughly 40% less code, and more capability.

## The conductor is code, not a model

`src/index.ts` is a deterministic TypeScript state machine. It schedules, validates, retries and
reaps. An LLM runs only *inside* a phase, plus a Haiku narrator that turns a phase's structured
result into a sentence for Slack.

Three things fall out of that:

1. **"Clear the context between tickets" is free.** The conductor has no context. Every phase is
   a fresh `query()` that is never resumed; when a run ends there is nothing to clear but files,
   and those get reaped.
2. **Runs are replayable.** A run is a journal of phase artifacts, so re-entering at phase 11
   costs nothing for phases 0–10.
3. **Spend goes to the work**, not to an orchestrator re-reading its own state every minute.

## Pipeline

```
 issue labelled `Loop`
   0  recall        Haiku    prior art from past runs
   1  research      Opus 5   trace the code path, state blast radius
   2  plan          Opus 5   phased plan
   3  testcases     Opus 5   ONE shared case list  ──┐
   4  implement     Opus 5   commits on oneshot/ticket-<iid>-<slug>
   5  review        Opus 5   findings ──► back to 4 (max 3 laps)
   6  verify        Sonnet 5 dev server + Playwright  ◄──┤ same list
   7  ui-evidence   Sonnet 5 screenshots              ◄──┤
   8  mr            Sonnet 5 MR + description
   9  merge         code     merge into dev, promote dev → stage
  10  deploy        code     scripts/deploy-wsai.sh → ws-ai-demo
  11  qa            Opus 5   run the case list on the deployed build ◄──┘
                             fail ──► back to 4 (max 2 laps)
  12  demo          Sonnet 5 recorded walkthrough
  13  document      Haiku    ticket note + MR note + uploads
  14  memorize      Haiku    memory card for future recall
  15  close         code     label → Ready For Deployment, teardown
```

`merge`, `deploy` and `close` are **code, not sessions**. No model holds a merge tool, which is
why One Loop's approval-label guard has nothing left to guard.

**Phase 3 exists so `verify` and `qa` execute the same list.** Without it each invents its own
scenarios, and a green local run and a green demo run cover different ground — you cannot
compare them, so the QA pass means less than it looks.

**Full auto.** There are no human gates. The only thing that stops a run is `BLOCKED` — a deploy
that exits non-zero, a cycle cap exhausted, an unresolvable MR conflict, GitLab unreachable past
the breaker, or a quota park. That posts an @mention and applies `Needs Human`.

## Quick start

```sh
git clone https://github.com/HassamAzam/oneshot.git && cd oneshot
npm install
npm start                                  # no .env? an interactive wizard runs first
```

`npm start` with no `.env` hands off to a setup wizard that reuses the GitLab token already in
`~/.claude.json`, detects your repo clones, and warns before configuring a remote telemetry
endpoint. Then `npm run verify` (deps → hooks → doctor) is the gate. It checks auth, config coherence, paths, GitLab reachability and
branch protection, that the hooks are installed and their test suite passes, and that the deploy
target is configured. It exits non-zero on anything that would only surface as a confusing
failure three phases into a real ticket.

- **Auth:** the Agent SDK uses the same credential as Claude Code — if `claude login` works here,
  phases run with no API key. **Never set `ANTHROPIC_API_KEY`.** See below.
- **Kill switches:** `touch state/PAUSE` freezes everything, including sessions already mid-phase.
  `state/PAUSE-QUOTA` is the machine's own park after a usage limit and clears itself — a
  separate file precisely so nothing automatic ever lifts a pause you set.
- **Dry run:** `DRY_RUN=1 npm start` runs every phase and denies every write. This is how you
  watch the pipeline drive a real ticket without touching it.

## Guardrails

Structure first, hooks only for what structure cannot reach:

| Layer | Used when | Evadable? |
|---|---|---|
| Structure — tool absence, `cwd`, code-not-model | the constraint can be made impossible | no |
| Hook | the model holds the tool but must not use it this way | no |
| Schema | the output shape is checkable | no |
| Skill / prompt | judgment, taste, method | yes — it's advice |

Installed hooks (`npm run hooks:verify` — 32 offline assertions, no network, no session):

- **`pause-check`** — the brake. Denies side-effectful tools while paused; denies all GitLab
  calls while the VPN breaker is open. Reads stay allowed, so an interrupted phase can still
  write a coherent summary.
- **`write-scope`** — per-phase write allowlist, plus two absolute denials for every phase: the
  Oneshot runtime itself, and the read-only context repo. It **realpath-resolves before
  comparing**, which is load-bearing: each worktree has `.claude/` symlinked into `~/Documents/erp`
  so phases get the real skills, and a prefix-only check would let an `implement` phase rewrite
  the skills that govern it.
- **`git-guard`** — no force-push ever; no push to `dev`/`stage`/`master`/`main`; no push to any
  ref but the leased branch; no protected-branch deletes; no `remote set-url`; no `gh`/`glab`;
  and no git command whose working directory escapes the worktree. `~/Documents/erp` is a live
  repo with a real remote on this machine, and a `git commit -am` with the wrong cwd lands there.
  `--no-verify` is deliberately allowed — the husky pre-commit hook is broken locally.
- **`budget-gate`** — refuses a phase whose per-phase, per-ticket, per-window or per-day weighted
  token ceiling is already spent.

**Guards are passed to the SDK in-process, not installed into `~/.claude/settings.json`.** They
travel with the repo, so a fresh clone is protected with no install step, and your own
interactive sessions are untouched *by construction* rather than by env-gating. The callbacks
shell out to the same `hooks/*.cjs` files the test suite exercises — one implementation, no
drift between a guard and its copy.

The original design loaded them via `settingSources: ['user']`. That dragged in the operator's
entire personal config, including a `npx`-based `statusLine` that hung every phase before its
first turn. Global install remains available (`npm run hooks:install`) but is no longer needed.

Design rationale for each, and the seven not yet built, is in [docs/HOOKS.md](docs/HOOKS.md).

## Running on a Max subscription

Dollars are the wrong unit. The SDK's `total_cost_usd` is computed locally at API list rates and,
per Anthropic, is not relevant for billing on a subscription. The real constraint is the rolling
5-hour and 7-day usage windows — **and Oneshot shares them with your own Claude Code.** An
unsupervised run does not cost you money; it costs you your own window at 4pm on a Thursday.

- **Token ceilings (always on).** Every session's counts are weighted into input-token-equivalents
  — `in×1 + out×5 + cache-write×1.25 + cache-read×0.1` — so one number compares across models and
  cache states. Enforced by the conductor before claiming and by `budget-gate` at `SessionStart`.
  One ticket runs **six Opus phases**, which is materially heavier than a One Loop iteration, so
  `config/budgets.json` starts conservative.
- **The reserve (one opt-in step).** The only first-party signal for account-wide window use is
  the `rate_limits` object Claude Code passes to an *interactive* status line; headless sessions
  never see it. Wire a harvester that tees your status-line stdin to
  `~/.claude/state/ratelimit.json` and Oneshot stands down at 70% consumed, keeping the last 30%
  yours. Without it, the token ceilings alone apply.
- **A real limit means stop, not retry.** `src/lib/quota.ts` matches the reset strings, parses the
  time, and writes `state/PAUSE-QUOTA`, which clears itself. 529/overloaded and "temporarily
  limiting requests (not your usage limit)" are explicitly *not* treated as quota events.

### Keep it on the subscription

`ANTHROPIC_API_KEY` outranks subscription OAuth, and in headless/SDK mode Claude Code uses a
detected key **silently, with no prompt** — the documented way a subscription fleet becomes a
metered bill.

`src/lib/config.ts` builds session env from scratch (the SDK's `env` option *replaces* rather
than merges, which is what makes it a control) and **deletes** `ANTHROPIC_API_KEY`,
`ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_BASE_URL` and `CLAUDE_CODE_USE_{BEDROCK,VERTEX,FOUNDRY}`. An
empty value is not safe — it still wins its precedence slot — so they are deleted, not blanked.
`npm run doctor` reports which credential is in play and flags an `apiKeyHelper` in
`~/.claude/settings.json`, because phases load user settings and a helper *would* run. The 1M
context window is disabled fleet-wide: it draws on purchased credits even when subscription
allowance remains, and that *is* a real charge.

## Surviving a VPN drop

GitLab and the demo box both sit behind FortiClient. Without a breaker, a dropped tunnel is the
most expensive thing this system can do — every phase burns its full timeout on calls that cannot
succeed. `src/lib/reachability.ts` runs three states: `ok` → `degraded` after 2 consecutive
failures → `recovering` on the first success → `ok` only after 2 more. `recovering` is what stops
a 5-second blip from flapping the run and the Slack channel.

**5xx counts as down** — GitLab answering 500, or a captive portal answering for it, means work
cannot proceed either way. **401/403 does not**: the server answered, so a bad token is an auth
problem, and letting it trip the breaker would make a wrong `GITLAB_TOKEN` look like an outage.

## Layout

| Path | What it is |
|---|---|
| `src/index.ts` | the conductor — boot, preflight, watch loop |
| `src/conductor/` | watcher, queue, phase runner, schema validation, teardown |
| `src/phases/` | one module per phase: prompt, schema, tool policy |
| `src/lib/` | config + session env, SQLite, GitLab, worktrees, quota, reachability, memory |
| `config/` | project + labels, per-phase model/tools/skills, budgets, deploy, Slack |
| `hooks/` | guardrails merged into `~/.claude/settings.json` |
| `scripts/` | hook install/verify, `doctor`, the vendored deploy script |
| `docs/` | [PLAN.md](docs/PLAN.md) · [HOOKS.md](docs/HOOKS.md) |
| `state/` | gitignored — runs, artifacts, memory, SQLite |

## Status

Built and **proven live** through **M1**. A `Loop`-labelled ticket runs
recall → research → plan → testcases against real GitLab, producing schema-valid artifacts
that hand forward. First end-to-end run on ticket #5 (Invoices):

| phase | result | turns | weighted tokens |
|---|---|---|---|
| `recall` | skipped (no memory yet) | 20 | 79k |
| `research` | ok — 21 cited code-path steps, 5 AC, 8 stated unknowns | 40 | 461k |
| `plan` | ok — 6 steps, 10 reuse items, 8 risks | 22 | 298k |
| `testcases` | ok — 19 cases, 9 high-blast, all 8 passes run | 16 | 176k |

~1.0M weighted tokens for a researched, planned, test-cased ticket.

| M | Ships | Status |
|---|---|---|
| M0 | skeleton, config, hooks + test suite, quota, breaker, watcher, doctor | **done** |
| M1 | phase runner, schema-enforced handoffs, run journal, teardown, phases 0–3, Slack card, Langfuse | **done, verified live** |
| M2 | phases 4–5 — implement, review, the review cycle | next |
| M3 | phases 6–7 — dev server on a leased port, Playwright, screenshots | |
| M4 | phases 8–9, 13 — MR, merge, promote, documentation, uploads | |
| M5 | phases 10–12 — deploy, demo-server QA, demo recording | |
| M6 | phases 0 + 14 — memory index and recall | |
| M7 | dashboard, replay, hardening hooks | |

A blank Status is work not yet started. `runner.ts` stops with an explicit
`BLOCKED: not built yet: phase '<name>'` rather than skipping ahead — including for the
deterministic `merge`/`deploy`/`close` phases, so a run can never reach
`Ready For Deployment` without having actually merged and deployed.

## What six live failures taught this design

Every one was found by running it, not by reading it. Only the first was predicted.

| Failure | Cause | Fix |
|---|---|---|
| Phase hung 6 min at **zero turns** | `npx -y @zereight/mcp-gitlab` re-resolves against the npm registry per spawn; npm is blocked behind the same VPN GitLab needs | MCP server is a real dependency |
| Still hung after that fix | `settingSources:['user']` loads the operator's `statusLine: npx ccusage@latest`, which hangs the same way | guards passed in-process; `'user'` dropped |
| `spawn node ENOENT` | resume trusted a `worktree` path that had been deleted — a missing `cwd` reports as ENOENT and reads like a broken PATH | validate and re-lease |
| Two conductors claimed one ticket | a killed `npm` wrapper orphans its `tsx` child; and `isClaimed()` lived only in the watcher, so `--ticket` bypassed it | PID-file singleton + claim inside `runTicket` |
| Duplicate claim notes | the note was re-posted on every resumption | once per run |
| Unimplemented `code` phases skipped silently | `kind: 'code'` was treated as nothing-to-do | explicit `CODE_PHASES` registry |

The recurring lesson: **nothing in this pipeline may shell out to `npx` at run time**, and
`npm run deps:verify` now spawns every out-of-process dependency for real — because checking
that a dependency is *configured* is not the same as checking that it *runs*.
