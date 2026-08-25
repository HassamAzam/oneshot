# One Loop v2 — "Conductor"

A single-orchestrator, per-ticket pipeline. One label in, `Ready For Deployment` out, fully
autonomous, one Slack voice.

**Target repo:** new GitHub repo (URL pending)
**Work repo:** `arbisoft/workstreamai` (branches, MRs, tickets)
**Context repo:** `arbisoft/erp` — read-only reference + **the source of all skills**
**Predecessor:** `github.com/HassamAzam/one-loop` — mined for proven parts, not extended

---

## 1. The one architectural change that drives everything else

**v1 is a distributed system.** Seven peer loops, each on its own timer, each with its own
Slack app and GitLab identity, coordinating through a GitLab label state machine. Because no
process owns a ticket, the labels *are* the consensus substrate — hence the closed label set,
the swap semantics, the `label-guard` hook that re-reads live GitLab before every mutation, the
claim-by-note-then-re-read race protocol, and the authenticated `HANDOFF:` marker parsed back
out of Slack.

**v2 is one process with a queue.** The Conductor owns a ticket from claim to close. Nothing
else can touch it. Consensus is not a problem you have when there is one owner.

Everything below falls out of that:

| v1 subsystem | v2 |
|---|---|
| Label state machine (9 labels, 11 transitions, closed set) | **Deleted.** `one-loop` in, `Ready For Deployment` out. Nothing in between. |
| `hooks/label-guard.js` + `config/labels.json` | **Deleted** (~350 lines + config) |
| Claim protocol (post note → re-fetch → verify newest is yours → else roll back) | **Deleted.** In-process lock + SQLite row. |
| `HANDOFF:` markers, `handoff.routes`, bot-author verification | **Deleted.** A phase returns a value to its caller. |
| 7 Slack apps, 7 manifests, 7 `xoxb-` tokens, per-persona channels | **1 app, 1 token, 1 channel, 1 thread per ticket** |
| 7 per-loop GitLab PATs | 1 bot token |
| `src/loops/*` peer loops on independent timers | `src/phases/*` — ordered stages of one run |
| Progress visible only as label churn on the board | Live Slack card, edited in place |

Net: roughly **40% less code, more capability, and a control flow you can single-step.**

## 2. The Conductor is code, not a model

The orchestrator loop is a **deterministic TypeScript state machine**. It does not think. It
schedules, validates, retries, and reaps. An LLM is invoked only inside a phase, or for the
one-sentence Slack narration (Haiku).

Three things this buys, all of which you explicitly asked for:

1. **"Clear the context after the ticket has finished"** becomes free — the Conductor *has* no
   context. Every phase is a fresh `query()` that is never resumed. When a run ends there is
   nothing to clear except files, and those get reaped.
2. **Replayability.** A run is a journal of phase results. `npm run replay 8607 --from qa`
   re-enters at phase 10 without re-paying for phases 0–9.
3. **Spend goes to the work.** No orchestrator session re-reading its own state every 60s.

The Conductor's *voice* is a small Haiku session per milestone that turns a phase's structured
result into a human sentence for Slack. That is the only thing that talks to you.

## 3. Pipeline

Trigger: GitLab issue in `arbisoft/workstreamai` carrying label **`one-loop`**.

Each phase is one fresh Agent SDK session with its own model, tool allowlist, cwd, turn cap and
wall-clock timeout. Handoff is a **schema-validated JSON artifact on disk**, never prose, never
a shared transcript.

| # | Phase | Model | cwd | Produces | On failure |
|---|---|---|---|---|---|
| 0 | `recall` | Haiku 4.5 | conductor | `prior-art.md` | skip (non-fatal) |
| 1 | `research` | **Opus 5** | worktree | `research.json` + `.md` | abort run |
| 2 | `plan` | **Opus 5** | worktree | `plan.json` + `.md` | abort run |
| 3 | `testcases` | **Opus 5** | worktree | `testcases.json` | abort run |
| 4 | `implement` | **Opus 5** | worktree | commits on ticket branch | retry ×2 |
| 5 | `review` | **Opus 5** | worktree | `findings.json` | → 4 (max 3 laps) |
| 6 | `verify` | Sonnet 5 | worktree + leased port | `test-report.json` | → 4 (max 2 laps) |
| 7 | `ui-evidence` | **Sonnet 5** | worktree + port | `shots/*.png` | warn only |
| 8 | `mr` | Sonnet 5 | worktree | MR + description | abort run |
| 9 | `merge` | *code* | — | merged, `dev` promoted | escalate BLOCKED |
| 10 | `deploy` | *code* | — | demo server on new SHA | escalate BLOCKED |
| 11 | `qa` | **Opus 5** | conductor | `qa-report.json` | → 4 (max 2 laps) |
| 12 | `demo` | Sonnet 5 | conductor | `demo.mp4` | warn only |
| 13 | `document` | **Haiku 4.5** | conductor | ticket note + MR note + uploads | warn only |
| 14 | `memorize` | **Haiku 4.5** | conductor | `memory/tickets/<iid>.md` | warn only |
| 15 | `close` | *code* | — | label → `Ready For Deployment`, teardown | — |

### Model assignment

- **Opus 5** — research, plan, testcases, implement, review, qa. Everything that requires
  judgment or divergent thinking.
- **Sonnet 5** — verify, ui-evidence, mr, demo. Structured execution against a spec.
- **Haiku 4.5** — recall, document, memorize, and all Slack narration. Mechanical.

### Phase 3 `testcases` is new, and it fixes a real gap

Without it, `verify` (local) and `qa` (demo server) each invent their own scenarios — so the
thing you tested locally and the thing you signed off on the demo server are **not the same
list**. Phase 3 brainstorms one case list from the plan + acceptance criteria, and phases 6, 7
and 11 all execute against it. One list, three executions, comparable results.

It runs on Opus because case brainstorming is divergent work — the value is in the edge case
nobody thought of, which is exactly what a weaker model drops.

### Cycles are bounded and carry findings forward

`review → implement` and `qa → implement` are real loops, capped at 3 and 2 laps. Each lap
re-enters `implement` with the outstanding `findings.json` — not a fresh "try again". On cap
exhaustion the run escalates BLOCKED with the unresolved findings **instead of merging**.

### Full auto, and where it still stops

Per your call: **zero human gates.** The only unprompted @mention is `BLOCKED`, which means
"no retry will help": deploy script non-zero exit, cycle cap exhausted, MR conflict it can't
resolve, GitLab unreachable past the breaker, quota park. Everything else runs to
`Ready For Deployment` on its own.

Kill switches survive: `state/PAUSE` freezes mid-flight (side-effectful tools denied inside
already-running sessions too), `pause` in Slack does the same.

## 4. Context discipline

Three layers, all structural rather than instructional:

1. **Phase isolation.** No session is ever resumed or continued. A phase receives the ticket
   body, the prior-art brief, and the *artifacts* of earlier phases — never their transcripts.
   Context grows in kilobytes, not conversation turns.
2. **Run teardown.** On close: remove worktree, drop the port lease, delete
   `state/runs/<iid>/scratch/`, post the final Slack card. Survives: `artifacts/` (screenshots,
   mp4, reports) and the memory card.
3. **No cross-ticket carryover.** The queue holds ticket IDs. That is all it holds.

## 5. Ticket memory — "search for a similar ticket and build context"

```
state/memory/
  index.jsonl          one line per completed run
  tickets/<iid>.md     the card
```

Index line: `{iid, title, labels, modules[], files[], symbols[], mr, verdict, tags[], ts}`

Phase 0 scores candidates on **file-path overlap, module overlap, label overlap, title-token
overlap** — BM25-lite, ~150 lines of plain TypeScript. No vector DB, no embedding calls. In a
monorepo the strongest "similar ticket" signal is "touches the same files," and that is exactly
what this measures. Top 3 cards are read and distilled into `prior-art.md`, injected into
phases 1–3.

The card is written by phase 13 to a fixed schema so phase 0 can find it: what the ticket was,
why the approach was chosen, files touched, gotchas hit, MR link, QA verdict.

## 6. Skills come from the ERP repo, live

v1 vendored copies into `skills/` and inlined them into system prompts. They drift the moment
you edit the real one.

v2: at worktree creation, symlink from `$ERP_SKILLS_ROOT` (default `~/Documents/erp/.claude`)
into `<worktree>/.claude/`:

```
<worktree>/.claude/skills   → ~/Documents/erp/.claude/skills
<worktree>/.claude/agents   → ~/Documents/erp/.claude/agents
<worktree>/.claude/rules    → ~/Documents/erp/.claude/rules
```

Phases run with `cwd = worktree` and `settingSources: ['user','project']`, so Claude Code
discovers them natively and the `Skill` tool works exactly as in your interactive sessions.
`config/phases.json` additionally names the skills each phase must invoke, so discovery is not
left to chance.

**You edit a skill in the ERP repo; the next run uses it. There is no sync step.** This reuses
v1's existing `SEED_LINKS` worktree machinery (which already symlinks `venv`/`node_modules`).

## 7. Slack — one app, one channel

- **Root message per ticket** = a live status card, **edited in place**: phase checklist with
  ✅/⏳/❌, elapsed time, current model, weighted-token spend.
- **Thread replies** = milestones only — plan summary, MR link, screenshot pack, demo video,
  QA verdict, BLOCKED.
- **Commands** keep v1's closed-grammar parser (it's the best security design in that repo:
  allowlisted sender + every token consumed by the grammar, or the message is not a command at
  all): `status`, `pause`, `resume`, `run <iid>`, `retry <iid>`, `abort <iid>`, `skip <iid>`.

## 8. What I carry over from v1 unchanged

These are hard-won and I am not rewriting them:

- **`config.ts` env scrubbing** — deletes `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN` /
  `CLAUDE_CODE_USE_*` from session env. This is the guard that stops a subscription fleet
  silently becoming a metered API bill. **Ports on day one.**
- **`lib/quota.ts`** — weighted-token accounting (`in×1 + out×5 + cache-write×1.25 +
  cache-read×0.1`), rate-limit string parsing, self-clearing `PAUSE-QUOTA`. **Day one** — a
  full E2E ticket runs Opus across four phases and is expensive.
- **`lib/reachability.ts`** — the 3-state VPN circuit breaker. GitLab is behind FortiClient and
  that tunnel drops; without this the loop pours sessions into a black hole.
- **`lib/worktrees.ts`** — worktree lease, seed links, port pool (8000/8001/8002).
- **`lib/loopid.ts` + OTel** — span identity, unchanged.
- **`hooks/`**, pruned to: `git-guard` (no force-push, no protected-branch push),
  `write-scope` (stay inside your worktree), `injection-scan`, `pause-check`, `budget-gate`,
  `sleep-cap`. `label-guard` is deleted with the label machine.
- **Slack listener grammar.**

## 9. Repo layout

```
one-loop-v2/
  package.json  tsconfig.json  .env.example  README.md
  config/
    pipeline.json     phase order, retry caps, cycle edges
    phases.json       per phase: model, tools, turns, timeout, skills[]
    models.json       tier → model id
    project.json      gitlab project, branches, entry/exit label
    slack.json        channel id, human allowlist
    budgets.json      weighted-token ceilings          (ported)
    deploy.json       your deploy script + health check + timeout
  src/
    index.ts                  npm start → conductor + slack + dashboard
    conductor/
      watcher.ts  queue.ts  runner.ts  phase.ts  schema.ts  teardown.ts  replay.ts
    phases/                   00-recall.ts … 14-close.ts
    lib/
      config.ts  db.ts  gitlab.ts  worktrees.ts  quota.ts  reachability.ts
      memory.ts  deploy.ts  artifacts.ts  narrator.ts  loopid.ts
    slack/  post.ts  listener.ts  card.ts
  hooks/        pruned guardrails
  dashboard/    run-centric (replaces the 5-tab board view)
  scripts/      install-hooks.sh  doctor.ts  replay.ts
  state/        gitignored — runs/, memory/, artifacts/, oneloop.db
```

`npm start` is the whole thing.

## 10. Superpowers — the skill catalog

### Reused from `~/Documents/erp/.claude/skills/` (symlinked, zero copies)

`planning-methodology` · `django-backend-standards` · `django-migration-standards` ·
`react-frontend-standards` · `django-query-optimisation` · `python-linting` ·
`script-writing-standards` · `util-reuse-methodology` · `mr-metadata` · `mr-change-logger` ·
`create-demo` · `erp-code-review` · `dead-code-sweep` · `graphify-knowledge-graph` ·
`test-erp-ticket` (+ its 5 phase skills)

Plus your agents, reused as SDK subagents in phase 3/4: `backend-agent`, `frontend-agent`,
`qa-agent`, `backend-reviewer-agent`, `frontend-reviewer-agent`, `util-reuse-agent`.

### New skills I will author (written into the ERP repo, so your interactive sessions get them too)

| Skill | Phase | What it encodes |
|---|---|---|
| `phase-handoff-contract` | all | Every phase ends by writing a schema-valid JSON artifact. Never narrate state in prose. Never assume a later phase read your transcript. |
| `ticket-recall` | 0 | How to score + read the memory index and write a prior-art brief that is short enough to inject into three later phases. |
| `ticket-research` | 1 | Read ticket + all comments, trace the code path with `file:line` citations, state blast radius, list unknowns explicitly rather than guessing. |
| `test-case-writing` | 3 | **Divergent** case generation, not a checklist. Enumerate happy / negative / edge / boundary / side-effect / regression / cross-module scenarios from the plan + AC; force a "what would a hostile QA try" pass; score each case by blast radius so `verify` and `qa` know what is worth the time. Output is the single shared case list phases 6, 7 and 11 all run. |
| `local-browser-verify` | 6 | Bring the worktree up on its leased port, wait out the webpack compile, log in through the real form, drive the changed screens, capture before/after. Encodes your isolated-worktree recipe, the `:8000` entry-point rule, and **Playwright only, never Jest**. |
| `ui-evidence-pack` | 7, 13 | Screenshot naming + annotation conventions, and the GitLab upload path rule (copy into a repo dir first — `upload_markdown` rejects scratchpad/absolute paths). |
| `demo-server-qa` | 11 | Run the shared case list against the deployed build, pass/fail *per case* with evidence. Never pass on a SHA the deploy didn't actually move. |
| `mr-documentation` | 13 | The MR body + ticket note format that becomes the durable record: what changed, why, how verified, evidence links, memory-card link. Extends `mr-change-logger`; respects "AC goes on the ticket, not the MR". |
| `ticket-memory-write` | 14 | Card schema + tagging vocabulary + what to omit, so future recall can actually find it. |
| `blocked-escalation` | any | What counts as blocked vs. retryable, and the exact Slack escalation format. |

## 11. Build milestones

Each milestone is independently runnable end-to-end on a real ticket — no milestone leaves the
system in a non-working state.

| M | Ships | Proves |
|---|---|---|
| **M0** | Repo skeleton, config, `scripts/doctor.ts`, hook install, Slack post, quota + reachability ported | Auth is on the subscription, GitLab reachable, label watcher sees a ticket |
| **M1** | Conductor + phase runner + result schema + run journal + teardown. Phases 0–3. | Research, plan and a shared case list land in Slack; context isolation works |
| **M2** | Worktree lease + seed links + skill symlinks. Phases 4–5 with the review cycle, lint/test gate. | Real commits on a real branch; the cycle terminates |
| **M3** | Phases 6–7. Local dev server on a leased port, Playwright verify, screenshot pack. | Browser verification is reliable enough to gate on |
| **M4** | Phases 8–9, 13. MR, merge, promote, ticket + MR documentation, screenshot upload. | The full write path to GitLab |
| **M5** | Phases 10–12. Deploy script, health poll, demo-server QA, demo recording. | *Needs your deploy script + demo URL* |
| **M6** | Phases 0 (real) + 14. Memory index, recall scoring, memory cards. | A second ticket in the same module gets cheaper |
| **M7** | Dashboard, `npm run replay <iid> --from <phase>`, blocked escalation polish | Operability |

## 12. Risks, named

1. **Full auto + a deploy script is the highest-blast-radius configuration in this design.**
   Mitigations: the deploy script is only ever invoked with the SHA this run produced;
   `git-guard` still forbids force-push and protected-branch push; `state/PAUSE` freezes
   mid-flight. **I want the deploy script itself to refuse any ref that isn't the ticket branch
   or `dev`** — a guard on your side, not just mine.
2. **Cycle divergence.** Hard caps (3 review laps, 2 QA laps). On exhaustion it escalates with
   the outstanding findings rather than merging — the failure mode is "stops and asks", never
   "merges something the reviewer rejected".
3. **Playwright flake is the #1 source of false `verify` failures.** Bounded with step-level
   retries; a flake that persists downgrades to a warning + screenshot rather than kicking the
   ticket back to `implement` and burning an Opus lap.
4. **Skill symlink visibility.** If `.claude/` isn't gitignored in `workstreamai`, the symlink
   shows up as an untracked change in every worktree. Fix is `.git/info/exclude` at worktree
   creation — needs a one-line check on first run.
5. **Quota.** Four Opus phases per ticket against a shared Max window. The quota layer ships in
   M0, not M7, and per-phase ceilings mean a runaway `implement` cannot starve the rest.

---

## Open items I need from you

1. **The new GitHub repo URL** — you referenced one but pasted the existing `one-loop`. Nothing
   gets pushed until you give me the new one.
2. **The deploy script** — path, invocation signature, what it takes (branch? SHA?), and its
   health/version endpoint so phase 9 can confirm the demo server actually moved.
3. **The demo server URL.**
4. **Confirm the work repo is `arbisoft/workstreamai`** and that `arbisoft/erp` is read-only
   context + the skill source.
