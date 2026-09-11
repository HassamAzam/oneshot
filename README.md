# Oneshot

One orchestrator. One label. Zero human gates.

Oneshot takes a GitLab issue in [`arbisoft/workstreamai`](https://gitlab.arbisoft.com/arbisoft/workstreamai)
carrying the label **`Loop`** and drives it — unattended — to **`merged`**: recall prior art,
research, plan, implement, brainstorm test cases, review, verify in a real browser, screenshot
the result, open the MR, and merge it.

**The pipeline ends at the merge.** Nothing is deployed, nothing is QA'd on a running build,
and no demo is recorded — deploying is a person's job, and the ticket says so when it hands
back.

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
| 9-label state machine, 11 transitions | `Loop` in → `merged` out. Nothing between. |
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
2. **Runs are replayable.** A run is a journal of phase artifacts, so re-entering at phase 8
   costs nothing for phases 0–7.
3. **Spend goes to the work**, not to an orchestrator re-reading its own state every minute.

## Pipeline

```
 issue labelled `Loop`
   0  recall          Haiku     prior art from past runs
   1  research        Opus 5    trace the code path, state blast radius
   2  plan            Opus 5    phased plan
   3  implement       Opus 5    commits on oneshot/ticket-<iid>-<slug>
   4  testcases    ∥  Opus 5    ONE shared case list, written against real code
   5  review       ∥  Opus 5    findings ──► back to 3 (max 3 laps)
   6  verify          Sonnet 5  dev server + Playwright, runs THE list
                                fail ──► back to 3 (max 2 laps)
   7  ui-evidence  ∥  Sonnet 5  screenshots
   8  mr           ∥  Sonnet 5  MR + description
   9  merge           code      merge into dev — dev is final, nothing promotes on
                                the run's record: ticket note, MR note, Slack,
                                label → `merged`, teardown

  ∥  runs concurrently with the phase above it

  ⟨R⟩ the optional `Review` label adds three human pauses to this same list —
      before 3, before 5, and inside 9. Nothing else changes: no phase is
      added, removed or reordered. See "Optional human review gates".
```

**Merge is the last phase.** A merged change is where this pipeline's warrant runs out: the
diff was reviewed and the case list was executed against a real browser on the branch, and
both of those are claims about the code. Anything past the merge — is it on the box, does it
work there — is a claim about a running system nobody here is watching, and a machine that
files that claim on a ticket is worth less than one that says plainly where it stopped.

`merge` is **code, not a session**. No model holds a merge tool, which is why One Loop's
approval-label guard has nothing left to guard — and being code is also what lets the last
phase re-derive, from the artifacts rather than from the phases' exit codes, whether `verify`
and `review` actually passed before it accepts anything.

**Phase 4 exists so the case list is written once and reviewed as a list.** A verifying session
that invents its own scenarios as it drives the browser produces a pass nobody can re-run:
there is no artifact to disagree with, and the cases quietly become whatever the session
thought of. Separating them makes "the change passes its own cases" a claim about a document a
person can read.

**It runs after `implement`, not before.** Writing the cases against real code buys concrete
steps — actual component names, routes, ids and error strings — instead of the approximations
you get from a plan. The cost is a list authored with the diff in view, which is how a case
list quietly ratifies a bug rather than catching it, so the prompt makes the acceptance
criteria the oracle and the diff merely the vocabulary: where the two disagree, the case is
written to the criteria and is expected to fail. `implement` therefore works from the plan
alone; on a cycle lap the cases already exist and are handed back to it. They are never
re-authored — one list, and a lap through `implement` hands the same list back.

**A death is not a verdict.** A phase that is cancelled by the conductor, killed by a signal, or
run out of wall clock never reached an opinion about the work, so it is recorded `infra` rather
than `failed` and re-attempted in place. It costs no lap and triggers no cycle: cycling back to
`implement` answers "the work came back wrong", and a session that died before producing any work
has said nothing to be wrong about. Two free re-attempts, after which it degrades to the phase's
ordinary `onFail` policy so a person still hears about it. This is what stops an interrupted run
from spending a phase's whole cycle budget on deaths that produced no findings, and then blocking
on the bookkeeping rather than on anything wrong with the ticket.

**A long phase says it is still alive.** Every minute, a session phase logs its turns and elapsed
time against their caps — `verify working turns=120/300 elapsed=47m/120m messages=1231` — because
a phase is otherwise silent for up to its entire timeout, and "working" and "wedged" look
identical from outside. A run that stops prints where it stopped, the trail of the last few
phases, and the recovery command, so the question "why did it stop" is answered on the console
rather than by reading the journal by hand.

**Full auto.** There are no human gates. The only thing that stops a run is `BLOCKED` — a cycle
cap exhausted, a verify that passed nothing, an unresolvable MR conflict, GitLab unreachable
past the breaker, or a quota park. That posts an @mention and applies `Needs Human`.

## Optional human review gates

Full auto, by default, for every ticket — the paragraph above is still true and stays true. This
is an **off-by-default, opt-in mode** for the ticket that wants a second look, not a second label
state machine: it does not touch the zero-human-gates default, and it cannot, structurally,
because every check it adds is an *additional* `labels.includes('Review')` guard around code that
already runs unconditionally. A ticket with no `Review` label drives exactly as described above,
with the exact same phases, the exact same code paths, and the exact same absence of a gate.

Why bother, given `README`'s own opening line and `docs/PLAN.md`'s "per your call: zero human
gates"? Because that call was about the *default*, and `docs/HOOKS.md`'s decision rule — structure
where the constraint can be made impossible, a hook where the model must not misuse a tool it
holds — has a third row this mode fills without touching either of the first two: a ticket a human
*chooses* to slow down for its own reasons (a sensitive module, a first run of a new kind of
change) should be able to, without every OTHER ticket paying for it and without resurrecting
`label-guard.js`'s closed label-state machine that v2 deliberately deleted (README's "Why this is
not One Loop v2", above).

Put the `Review` label on a ticket **alongside** `Loop` and three pause points activate. **GitLab is
the approval channel, and Slack is where the ask is heard.** Oneshot posts the request as a ticket
comment and reads the verdict back out of that ticket's comments; the same ask is simultaneously
posted into the run's Slack thread and **broadcast to the channel, @mentioning the group that owns
the gate**. The two halves are not redundant. A ticket comment notifies whoever already subscribed
to the ticket, which is nobody in particular — that is how a run ends up parked for a day on a
reviewer who never learned they were being waited on. A Slack ping reaches the people, and reaches
them where they already are.

Approval is read on the ticket rather than in Slack for one reason: **authorisation**. Sign-off is
restricted to two named groups (`config/reviewers.json`), and the only identity a Slack reply
carries is a Slack user id, which cannot be matched against a GitLab username. Reading the verdict
where the reviewer is signed in under their own GitLab account is what makes "only these people may
approve" enforceable rather than advisory. So Slack here is strictly **write-only**: nothing is
ever read back out of it, and a Slack that is down, unconfigured, or missing a scope costs a
notification and never a verdict.

```
 … plan ──▶[ R1 approve the plan ]──▶ implement ──▶ testcases ──▶[ R2 approve the case list ]──▶ review …
 … mr ──▶[ R3 a human merges the MR ]──▶ the run's record, and done

 R1, R2   a ticket comment of `approved` releases the pause; anything else is feedback.
          Devs own R1, QA owns R2 (config/reviewers.json) — and are @mentioned in Slack
 R3       no keyword — the MR's own state turning `merged` is the signal
```

1. **Plan approval** — after phase 2 (`plan`), before phase 3 (`implement`). Oneshot posts the
   plan itself as a ticket comment, pings the **dev** group in Slack, and the run **parks**.
2. **Test-case approval** — after phase 4 (`testcases`), before phase 5 (`review`). The list of
   cases this run intends to verify is posted the same way and pinged to **QA**, and the run
   **parks**. It sits here, and not after `verify`, because this is the last point at which
   approving still changes anything: an edge case added here is carried into `review`, into
   `verify` and into the MR. The same reply taken after the run had merged could only become a
   follow-up ticket — a gate that cannot change what it guards is decoration. It carries no
   verdict, deliberately: nothing has executed the list yet, and there is no result to summarise.
3. **The merge itself** — inside phase 9 (`merge`), still pure code, still no model. On a
   Review ticket Oneshot **never accepts the MR**, however green the pipeline or complete the
   approvals: it opens the MR and from there only watches. Merging is a person's decision,
   because it is the last irreversible step and that is precisely the step this label exists to
   reserve for a human. The phase parks until the MR's own state reads `merged`, whoever merged
   it and whenever, then writes the run's record and finishes. Because that decision is measured
   in hours, the question is put to GitLab every 30 minutes (`MERGE_POLL_MS`); ticks in between
   park without a network round trip.
**The label is not the only trigger.** A person applies it, so it is forgettable — and the
tickets most worth pausing on are exactly the ones nobody remembers to label. So the gates also
arm themselves when a run *touches* anything in `highScrutinyPaths` (config/project.json):
`apps/auth/`, `apps/payroll/`, `apps/leaves/`, `apps/project_logs/`, `common/permissions.py` —
the same paths the ERP's own `security.md` marks "escalate immediately".

The check runs against what the run has declared it will touch: the `files` on each plan step at
the plan gate, plus `implement`'s reported `filesChanged` by the test-case gate. Evaluating it
twice is deliberate — a plan that swore off payroll and a diff that edited it anyway is precisely
the case worth catching, and only the second evaluation sees it. When paths arm the gates,
`reviewMode` is persisted on the journal so the pure-code `merge` phase honours a pause no label
ever asked for, and the request says which path armed it rather than claiming a label that is not
there. Empty the array to switch the behaviour off.

**Comment `approved`** (that exact word, case-insensitive, trimmed — not a substring of a longer
reply) **on the ticket** to release a pause. It only counts from an account in that gate's own
group: an `approved` from outside the list is logged and ignored, and so is any other comment, so
ordinary ticket chatter cannot knock a run into a revision cycle. **Any other comment from a
listed reviewer is feedback, and the two gates treat it differently:**

- The **plan gate** re-runs `plan` with it appended, and posts the revised plan back to the
  ticket for another round.
- The **test-case gate** reads it as edge case(s) to add rather than a reason to redo any work:
  each line of the comment becomes a new case, appended straight into `testcases.json` (see
  `appendEdgeCases()` in `src/conductor/reviewgate.ts`), and the SAME gate asks again with the
  updated list — no phase re-runs, no cycle back to `implement`. Because this happens before
  `review`, those cases are part of what this run actually verifies.

Either way, a round's outcome reaches GitLab only as an `addIssueNote` audit record — "the plan was
approved", "here is the approved test-case list" — posted once the gate actually resolves. There is no cap on how many rounds either gate can take.

**Mentioning the reviewers needs a Slack scope, and granting it is a manual step.** Slack renders
an @mention from a member id (`<@U01ABC>`) and from nothing else — a username in the message text
is inert, and silently so. `config/reviewers.json` holds GitLab usernames, so Oneshot bridges the
two by completing each username to a work address (`emailDomain` in that same file) and resolving
it through `users.lookupByEmail`. That needs **`users:read.email`** (which implies `users:read`)
on the bot token; `chat:write` covers every other call this app makes but not that one. A token
cannot grant itself a scope, so **a human has to add it in the Slack API console** — the app's
OAuth & Permissions page → Bot Token Scopes → add the scope → reinstall the app to the workspace.

Skipping it degrades one notch and no further: Slack answers `missing_scope`, the ask still posts
to the channel, and it simply names the reviewers as plain text instead of pinging them. **Nothing
about the verdict depends on it**, because the verdict is read from GitLab. `npm run doctor`
resolves every name for real and tells you which ones do not — a reviewer whose email does not
follow the convention fails exactly the same silent way as an ungranted scope, and both end in a
person not learning they are being waited on.

**Parked is not `Needs Human`.** A block swaps the ticket's label and needs a person to remove it;
a park changes no label and is picked up by the next tick's ordinary scan
exactly like a `running`/`aborted` resumption — the *only* new mechanism here is the label check
and the reply-polling, described in `src/conductor/reviewgate.ts`'s file header. It also holds no
dispatch slot, no port and no promotion window between checks, so a Review-labelled ticket parked
for a slow reviewer does not starve every other ticket the way a naive "just wait inside the
phase" implementation would.

Plain `--ticket <iid>` has no scan loop behind it, though — it runs one pass and exits, parked or
not, so a Review-gated ticket driven that way needs someone to notice the Slack reply and re-run
the command by hand. `npm start -- --ticket <iid> --follow` closes that gap: it keeps the process
alive and re-checks that SAME ticket — never anything else the board might also be claimable for —
every three minutes (`FOLLOW_TICK_MS`) until the run reaches `done` (exit 0) or a genuine `blocked`
(exit non-zero, reason printed). A `parked` run is re-checked on every one of those ticks and never
gives up on its own: it keeps asking until the thread answers with `approved` or with feedback,
which is what actually picks up a human's reply without a manual re-invoke. A transient failure to
read the ticket from GitLab is retried the same way rather than ending the process.

Three minutes rather than the watcher's `TICK_MS` minute, because a parked run re-enters the
pipeline on every tick and any phase without a recorded success is re-attempted from scratch each
time — a `skip`-on-fail phase like `recall` burns a full model lap per tick for as long as a human
takes to reply. The slower cadence still reads a reply promptly while spending a third as much.

## Mobilizing agents

Sixteen phases deep, and most of them spend their time waiting — on a webpack build, on a
GitLab poll, on a browser. Four kinds of concurrency shorten the wall clock, and none of them
weakens an invariant.

**Parallel phase groups.** A `group` in `config/phases.json` marks consecutive phases that read
the same inputs and write disjoint artifacts. The runner starts them together and then processes
their outcomes *in phase order*, so the first failure still owns control flow and a group is
never a way for a later phase to overrule an earlier one. Three today: `testcases ∥ review`
(both consume only `implement`, neither reads the other) and `ui-evidence ∥ mr` (a browser pass
and a git push — disjoint tools, disjoint writes).

**Parallel subagents inside a phase.** `review` dispatches `backend-reviewer-agent`,
`frontend-reviewer-agent` and `util-reuse-agent` in a single message, so a full-stack diff gets
three specialists at once instead of three specialists in a row.

**Pipelined tickets.** `concurrency` is 2, and the tick loop keeps scanning while runs are in
flight. Two runs must still not be inside the merge window at once — that is stated precisely
rather than approximated by a global serialisation: `src/lib/promotion.ts` is an in-process FIFO
mutex held across `merge` and released when the run ends. Only that window is serialized;
everything else pipelines.

**The port pool is the real ceiling.** `verify` and `ui-evidence` run a dev server, and
`PORT_POOL` (3 by default) bounds how many can at once. A run leases its port when it first
reaches a phase that needs one — not when it leases its worktree, because holding 8001 through
forty minutes of `research` buys nothing and starves the pool.

## Quick start

```sh
git clone https://github.com/HassamAzam/oneshot.git && cd oneshot
npm install
npm start                                  # no .env? an interactive wizard runs first
```

`npm start` with no `.env` hands off to a setup wizard that reuses the GitLab token already in
`~/.claude.json`, detects your repo clones, and warns before configuring a remote telemetry
endpoint. Then `npm run verify` (deps → hooks → doctor) is the gate. It checks auth, config coherence, paths, GitLab reachability and
branch protection, and that every guard script is present and its test suite passes. It exits
non-zero on anything that would only surface as a confusing failure three phases into a real
ticket.

- **Auth:** the Agent SDK uses the same credential as Claude Code — if `claude login` works here,
  phases run with no API key. **Never set `ANTHROPIC_API_KEY`.** See below.
- **Kill switches:** `touch state/PAUSE` freezes everything, including sessions already mid-phase.
  `state/PAUSE-QUOTA` is the machine's own park after a usage limit and clears itself — a
  separate file precisely so nothing automatic ever lifts a pause you set.
- **Paths:** the four path defaults are one machine's layout (`~/Documents/...`), so a fresh
  clone almost certainly needs to override them. Note the third is **not** named after its label:

  | Env var | Default | What it is |
  |---|---|---|
  | `WORK_REPO` | `~/Documents/workstreamai` | the clone phases actually commit in |
  | `CONTEXT_REPO` | `~/Documents/erp` | read-only clone for research |
  | `ONESHOT_SKILLS_ROOT` | `~/Documents/erp/.claude` | skills handed to the phases |
  | `WT_ROOT` | `~/Documents/oneshot-wt` | where per-run worktrees are leased |
  | `ONESHOT_SEED_FROM` | _(unset)_ | an already-installed clone whose `node_modules`/`venv` are linked into each new worktree, with `ONESHOT_SEED_LINKS` / `ONESHOT_SEED_COPIES` naming what to carry |

  Leave `ONESHOT_SEED_FROM` unset and a leased worktree has no dependencies, so `verify`
  (phase 6) cannot start the app — a failure that surfaces three phases after the cause.
  `doctor` warns about this at boot instead.

- **Seeding — the seed clone must be *installed*, not just present.** A leased worktree is a bare
  `git worktree`: it has none of the gitignored pieces a checkout needs to *run*. Oneshot never
  installs them (that would cost `npm install` minutes per ticket); it carries them over from
  `ONESHOT_SEED_FROM` when the worktree is leased. `npm run setup` writes that path for you but
  installs nothing — **you install the seed clone once, by hand**, following the work repo's own
  README (*Conventional Setup → Installation*). Four entries are carried, named in `.env`:

  | Entry | How | Why that way |
  |---|---|---|
  | `venv` | symlinked | heavy, read-mostly — one copy serves every worktree |
  | `node_modules` | symlinked | same; lives at the repo **root** (the root `package.json`), not under `frontend/` |
  | `hrdb/local_settings.py` | copied | settings — a worktree that edits its own must not edit the seed's |
  | `frontend/src/constants/config.js` | copied | same |

  Two things the work repo's README will not tell you:

  - **Name the virtualenv `venv`.** That README says `virtualenv -p python3.12 my_env`; the phases
    run `source venv/bin/activate` inside the worktree, so a `my_env` is invisible to them and the
    `venv` seed entry stays missing. Create it as `venv`, or `ln -s my_env venv` in the seed clone.
  - **Both settings files are hand-written** — there is no `.example` to copy. Their contents are in
    that README (`local_settings.py` under the backend steps, `config.js` under the frontend steps).

  Reading `doctor`'s two seed-related lines:

  | Line | Meaning | Action |
  |---|---|---|
  | `WT_ROOT will be created on first run` | expected — the worktree root is made on the first lease | none |
  | `no seed repo configured` | `ONESHOT_SEED_FROM` is unset | set it (or re-run `npm run setup`) |
  | `seed entries missing from the seed repo: …` | the clone exists but is not installed — the list names exactly what to create | install the clone; re-run `doctor` |

  You are done when `doctor` prints `seed repo <path> (3 linked, 2 copied)`. Both warnings are
  **non-blocking for `doctor` and blocking for the first ticket**: a missing entry does not fail at
  boot, it fails when `verify` tries to start the dev server, three phases in.

- A missing `SKILLS_ROOT` also fails `hooks:verify`'s symlink test, so one wrong path reports as
  two failures — fix the path and both clear.
- **Dry run:** `DRY_RUN=1 npm start` runs every phase and denies every write. This is how you
  watch the pipeline drive a real ticket without touching it. Its journal goes to
  `state-dry/state/runs`, not `state/runs`, so view it with a dashboard that resolves the same
  home: `DRY_RUN=1 ONESHOT_DASHBOARD_PORT=8788 npm run dashboard`. A dry run will not appear on
  the ordinary dashboard, and neither will anything that did not go through the conductor.

## The app, in one command

Bringing this app up used to be the largest single cost in a run, and it was paid again on
every phase, every session and every laptop. It is now one command, and it is the front door
for humans and phases alike:

```sh
npm run app -- ensure --ref <branch|!MR|#PR|sha>   # or: node scripts/app.cjs ensure ...
npm run app -- list                                # every instance running on this machine
npm run app -- gc --kill                           # reap servers whose run died days ago
```

`ensure` answers one question machine-wide — *is an app already running, and is it on my
code?* — and takes whichever path applies. Measured on the machine this was written on:

| what it finds | what it does | cost |
|---|---|---|
| an app already serving that commit | hands it over untouched | ~3s |
| an app up on other code, in a worktree we own and that is clean | checks the ref out into it, migrates if the diff carries migrations, restarts Django, waits for webpack's incremental rebuild | ~11s |
| nothing usable | seeds a worktree and cold-starts both processes | ~2min |

All three print the same `app-env.json`, so nothing downstream branches on which one ran.

Two things it deliberately will not do. It never checks a ref out into a checkout it did not
create — your own repo is usually running and usually has uncommitted work in it, and a
`git checkout` into that is not a cost saving. And it never guesses at a failure: it returns a
named code (`E_NO_PORTS`, `E_SEED_MISSING`, `E_DJANGO_DEAD`, `E_NO_REBUILD`, …) with the hint
that fixes it.

`skills/local-browser-verify/scripts/harness.cjs` still owns *how* this app starts — the ASGI
wedge, `CI=true`, the two files that pin the ports, what "ready" actually means. `app.cjs` owns
only the reuse decision, and imports the rest rather than restating it.

### The conductor starts it, not a model

No phase pays for a bring-up any more. Two things happen without anyone asking:

- **At loop boot**, the conductor warms one instance for itself, in its own worktree
  (`warmLoopApp`). A second conductor gets its own rather than sharing — a shared instance is
  a port its owner is about to want. What this is really keeping hot is the babel cache under
  the seed repo's `node_modules`, which every worktree on the machine symlinks: warm, the next
  worktree's first build is two minutes; cold, it is twenty.
- **At worktree lease**, each run starts its own app in the background, in its own leased
  worktree, and carries on immediately. webpack compiles through `research`, `plan` and
  `implement` — two and a half hours that were being spent anyway — so `verify` opens a
  browser against something already serving.

Phases still run `node $ONESHOT_HOME/scripts/app.cjs ensure` themselves, with no arguments:
it reads `$ONESHOT_WORKTREE` and `$ONESHOT_PORT` and brings up the app for *that* checkout,
never moving its ref. That call is the handshake. `app.cjs` holds a per-worktree lock, so a
phase either gets the finished instance back in about a second, or joins the bring-up already
in flight instead of killing it and starting a second one — which is the failure this design
exists to make impossible.

The one cost: a run now holds a pool port for its whole life rather than only for the phases
that bind a socket. With `PORT_POOL` three wide and `concurrency` 1, that is one port per
conductor, which is what "one app per run" is worth. A run that cannot lease a port does not
fail — it just does not get its head start, and `verify` leases one the old way.

## Claims across machines

The SQLite claim proves a ticket is yours on *this* machine, and nothing on another laptop can see
that row. Two conductors on two desks both pass it, both start, and the second finds out three
phases later when the merge collides. The only state every conductor shares is GitLab, so the
claim lives there too — in the ticket's comments (`src/lib/claims.ts`):

- Every run posts `Oneshot claimed this ticket — run \`r-…\` (<operator>)` at its top. It always
  did; now it is read back.
- **The oldest live claim note owns the ticket.** Note ids are monotonic, so this is an integer
  compare, not a clock compare across machines that disagree.
- Before a fresh claim counts, the conductor posts its note and **waits `ONESHOT_CLAIM_SETTLE_MS`
  (15s)** for a simultaneous claimant's note to land. Then oldest wins; the loser **deletes its
  note and stands down** (`aborted`, leases released, no label swap). The scan skips a
  foreign-owned ticket for as long as that claim is live, so a lost ticket costs one notes read
  per tick, not a retry.
- A claim is *live* while no later note reports its run stopped/complete **and** it is younger
  than `ONESHOT_CLAIM_STALE_HOURS` (24). The bound is the escape hatch for a conductor that died
  without a stop note; it is a day, not an hour, because a parked run legitimately waits days on a
  human. To release a ticket sooner, **delete the stale claim note on the ticket by hand.**
- The Slack card carries the owner (`ONESHOT_OPERATOR`, else `BOARD_OPERATOR`, else the OS
  username), so several desks posting into one channel stay tellable apart.

Peers still on the previous version of this code post the same claim phrase and are honoured as
owners; they just never yield, so until they upgrade the newer conductor is the one that backs off.

## Guardrails

Structure first, hooks only for what structure cannot reach:

| Layer | Used when | Evadable? |
|---|---|---|
| Structure — tool absence, `cwd`, code-not-model | the constraint can be made impossible | no |
| Hook | the model holds the tool but must not use it this way | no |
| Schema | the output shape is checkable | no |
| Skill / prompt | judgment, taste, method | yes — it's advice |

The guards (`npm run hooks:verify` — offline assertions, no network, no session):

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
**Every guard fails open, and the exception is kept for the next one that must not.** A guard
that crashes must not wedge a 90-minute phase, so a spawn error, a timeout or non-JSON output
from `pause-check`, `write-scope`, `git-guard` or `budget-gate` is logged loudly and treated as
allow — they are policy on operations the pipeline is otherwise structured to survive. The one
guard that failed CLOSED was `deploy-guard`, which stood between a confused phase and a live
demo server; it went with the deploy phase. `src/conductor/hooks.ts` still keeps the
`FAIL_CLOSED` set, empty, because the asymmetry is the load-bearing idea: a guard standing in
front of an irreversible action must deny when it cannot run.

**Guards are passed to the SDK in-process, not installed into `~/.claude/settings.json`.** They
travel with the repo, so a fresh clone is protected with no install step, and your own
interactive sessions are untouched *by construction* rather than by env-gating. The callbacks
shell out to the same `hooks/*.cjs` files the test suite exercises — one implementation, no
drift between a guard and its copy.

The original design loaded them via `settingSources: ['user']`. That dragged in the operator's
entire personal config, including a `npx`-based `statusLine` that hung every phase before its
first turn. There is no global install path any more — it would double-run every guard.

Design rationale for each, and the ones not yet built, is in [docs/HOOKS.md](docs/HOOKS.md).

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

GitLab sits behind FortiClient. Without a breaker, a dropped tunnel is the
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
| `src/index.ts` | the conductor — boot, preflight, watch loop, dispatch, drain |
| `src/conductor/` | watcher, queue, phase runner, the `merge` code phase, schemas, hook wiring, teardown |
| `src/phases/` | one module per phase: prompt, schema, tool policy |
| `src/lib/` | config + session env, SQLite, GitLab, worktrees, promotion mutex, quota, reachability, memory |
| `config/` | project + labels, per-phase model/tools/skills/groups, budgets, reviewers, Slack |
| `hooks/` | guardrails — passed to the SDK in-process, never installed globally |
| `scripts/` | hook verify, `doctor`, preflight, dependency probe, unblock, report |
| `docs/` | [PLAN.md](docs/PLAN.md) · [HOOKS.md](docs/HOOKS.md) |
| `state/` | gitignored — runs, artifacts, memory, SQLite |

## Status

All eleven phases are **built**. Everything past M1 is code-complete and **unproven live** —
that distinction is the whole point of this section, and this repo has already learned six times
over that reading code is not running it.

**Proven live** through **M1**. A `Loop`-labelled ticket runs against real GitLab, producing
schema-valid artifacts that hand forward. First end-to-end run on ticket #5 (Invoices), on the
then-current order of recall → research → plan → testcases:

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
| M1 | phase runner, schema-enforced handoffs, run journal, teardown, `recall`/`research`/`plan`/`testcases`, Slack card | **done, verified live** |
| M2 | `implement`, `review` and the review cycle | built, unproven |
| M3 | `verify`, `ui-evidence` — dev server on a leased port, Playwright, screenshots | built, unproven |
| M4 | `mr`, `merge` — MR, merge, promote, and the run's record on the ticket and the MR | built, unproven |
| M5 | ~~`deploy`, `qa`, `demo`~~ — **removed**: the pipeline ends at the merge | withdrawn |
| M6 | `recall` — memory index and recall | built, unproven; nothing writes new cards since `memorize` was removed |
| M7 | dashboard, replay, hardening hooks | not started |

`runner.ts` stops with an explicit `BLOCKED: not built yet: phase '<name>'` rather than skipping
ahead — including for the `merge` code phase, so a run can never reach `merged` without having
actually merged.

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
