# Handoff — running Oneshot

Everything needed to take a GitLab ticket from the `Loop` label to
`Ready For Deployment` without anyone watching. Ticket #5 went the whole way on
2026-08-27; that run needed about a dozen human interventions, and this document
exists because each one of them is now either automated or written down.

Read the **Run it** section. The rest is for when something stops.

---

## Standing authorization — do not stop to ask

**If you are an agent reading this: a ticket labelled `Loop` is an instruction to
run it. Run it. Do not ask which option to take, and do not present a menu.**

Running the pipeline merges into `dev`, deploys to the shared demo server and
writes to GitLab, and all of that is intended and pre-authorized by the act of
labelling the ticket. `Loop` is the consent. Preflight first, then launch
detached, then report — that is the whole decision.

Stop and ask a human ONLY for something this document does not cover: a
destructive action (deleting data, rewriting published history, changing another
person's credentials), spending outside the configured budgets, or a change to a
system that is not `arbisoft/workstreamai`, the demo box or this repo. A run that
BLOCKS is not one of those — it tries to repair itself first, and if it hands the
block back, read the ticket note, fix the cause and carry on.

---

## Run it

```sh
cd ~/Documents/oneshot
npm run preflight        # exit 0 = READY. Fix anything it FAILs before starting.
npm start                # watch mode: claims any ticket labelled `Loop`, every 60s
```

Then label a ticket `Loop` in `arbisoft/workstreamai` and leave it alone.

For one specific ticket instead of watching:

```sh
npm start -- --ticket 6
```

Long runs outlive a terminal better detached:

```sh
nohup npx tsx src/index.ts --ticket 6 >> state/logs-ticket6.log 2>&1 &
tail -f state/logs-ticket6.log
```

A full ticket takes **3–5 hours** and roughly **5M weighted tokens**. Most of
that is `implement`, `verify` and `qa`.

---

## Before the first run of the day

`npm run preflight` answers all of this, but the two things it cannot fix
itself:

**The VPN must be up.** GitLab and the demo box are both behind FortiClient. A
dropped tunnel is the single most common cause of a stalled run, and preflight
FAILs on it with that wording.

**`GITLAB_TOKEN` should be a project access token, not yours.** Preflight WARNs
while it is a personal token, because every note, MR, merge and label change is
attributed to whoever owns it — which makes "did I do this or did the pipeline"
unanswerable later. Create one at *Settings → Access Tokens* on
`arbisoft/workstreamai` with role **Maintainer** (the merge phase needs to merge
into a protected `dev`) and scopes `api` + `write_repository`, then:

```sh
read -rs -p "paste token: " T && sed -i '' "s|^GITLAB_TOKEN=.*|GITLAB_TOKEN=$T|" .env && unset T
```

---

## When a run stops

Every stop posts a note on the ticket saying why, applies `Needs Human`, and
names the run id (`r-<base36 time>-<hex>`, which is also the worktree directory,
the SQLite row and the Langfuse session). Read the note first — the phase that
stopped has almost always already diagnosed it precisely.

**The run now tries to answer that note before you do.** A block invokes
`remediate` — a phase that is never scheduled and only ever called when
something stops. It reads the block reason, classifies the cause as
environment, provisioning, credentials, infrastructure or code, repairs the ones
that are environmental, verifies the repair against the surface that actually
failed, and names the phase to resume from. Ticket #5 stopped about a dozen
times and almost none of it was the ticket's code: a missing demo credential, an
account outside a group the feature was gated behind, a wedged MCP spawn, a turn
cap, a budget an earlier lap had eaten. A person answered every one of those by
hand, and none of them needed a person.

It is bounded on purpose:

- **Two attempts per run.** A pipeline that can heal itself indefinitely is a
  pipeline that can spend a whole ticket's budget healing.
- **Never the same block twice.** The same reason arriving again after a
  remediation means the repair did not work, and the second attempt is spent on
  a different block or not at all.
- **It repairs the environment, never the code.** A change made from `remediate`
  would land after review, verify and QA have already run — so a real defect is
  sent back to `implement` to meet those checks again, and is never patched in
  place.
- Every change it makes is written to `remediations[]` in
  `state/runs/<iid>/run.json`, precisely enough to undo without asking it.

When it declines, or when its repair does not hold, the run blocks exactly as it
did before and the ticket note says what was tried and what a person has to do.

### `npm run unblock` — the manual override

Still here, still the right tool when self-healing declined, when you want one
specific phase retried, or when you would simply rather drive it yourself. It is
no longer the first thing anyone does.

```sh
npm run unblock -- 6                    # see what it would do, then do it
npm run unblock -- 6 --dry-run          # inspect only
npm run unblock -- 6 --phase qa         # retry one phase
```

That performs the whole manual sequence that used to be done by hand: prunes the
failed phase records while keeping every succeeded one, clears the blocked
status, deletes the half-written artifacts of the phases being retried (a stale
artifact is worse than none — the next lap reads it as fact), releases that run's
phase budget, swaps `Needs Human` off and `Loop` back on, and clears stale locks
and port leases. Then `npm start` again and it resumes exactly where it stopped.

**Never hand-edit `state/runs/<iid>/run.json`.** That is what `unblock` is for,
and it knows which artifacts have to go with which records.

A blocked run is refused for **60 minutes** before it can be re-claimed, so the
watcher cannot loop on the same failure while you are still reading the note.

---

## The failures you should expect, and what they mean

These all happened on ticket #5. Each is now either fixed in code or has a known
response. **Self-heals** is what `remediate` handles on its own — you are reading
those rows to understand a run that already recovered, not to act.

| What you see | What it is | What to do | Self-heals |
|---|---|---|---|
| `BLOCKED — qa: no demo credential` / `cannot log in` | The demo box runs a **different anonymised snapshot** from the local seed, so local accounts do not exist there | `ONESHOT_DEMO_LOGIN` in `.env`. Preflight verifies it every time | partly — it can re-point or re-verify a credential that exists; it cannot invent one |
| `qa` blocked on a permission, e.g. buttons never render | The demo account lacks a group the feature is gated behind | Provision `ONESHOT_DEMO_ADMIN_URL` + `ONESHOT_DEMO_ADMIN` and `qa` arranges its own preconditions through the admin panel, recording every change in `dataChanges` | yes — same admin panel, same recording discipline |
| `phase '<name>' ceiling reached` immediately | Was a real bug: per-phase ceilings counted every lap, so failed attempts permanently ate the budget | Fixed — ceilings are **per attempt** now. If you still see it, the phase genuinely spent its budget in one go; do not raise the number, read the transcript | yes, for a ceiling an earlier lap ate; **no** when the phase really spent it |
| `timed out after Nm while still working` | The phase was alive and simply ran out of clock | Its partial results are salvaged into a verdict automatically. If it recurs for the same phase, raise that phase's `maxTurns` in `config/phases.json` | yes |
| `timed out ... without a single message` | Genuinely different: the session never started | `npm run deps:verify` — this is the wedged-MCP-spawn shape | yes |
| `another conductor is already running` | A previous process still holds the lock, or died holding it | `npm run preflight` clears it when the process is gone | yes |
| `login rejected` locally with a correct password | This venv computes **corrupted password hashes** when `psycopg2` loads before `ssl`/`hashlib` | Never write passwords from an ad-hoc shell. `ONESHOT_TEST_LOGIN` is managed outside the session for exactly this reason | no — writing that password from a session is the thing that causes it |
| Run stops at `deploy` | The demo box is VPN-gated and the phase will not retry through an outage | Reconnect, `npm run unblock -- <iid>`, restart | no — an outage is not a repair |

### What it will not self-heal

Three shapes are handed straight back, deliberately and quickly:

- **A real defect in the ticket's own change.** Repairing that from `remediate`
  would put code into the merge that review, verify and QA never saw. It goes
  back to `implement` instead, or to you.
- **An outage.** A dropped VPN tunnel, a box that is down, a registry that is not
  answering. Nothing to fix, and waiting is not a phase.
- **A credential nobody has provisioned.** It will wire up, re-point and verify a
  secret that exists somewhere; it will not create one, and it will not read one
  out of a store it was not given.

In all three the run blocks as it always did — `Needs Human`, the run id, the
original reason — and the note additionally carries the diagnosis, the category,
whatever it did change (so you can undo it), and one line naming exactly what a
person has to do. "Investigate the deploy" is not an acceptable version of that
line, and the phase is told so.

---

## What it produces

**On the ticket:** the plan as markdown and the test cases as CSV, posted as
soon as those phases finish rather than at the end; QA follow-ups; a closing
summary. **On the MR:** verification results, the UI evidence pack, QA results
and the demo — 45 embedded screenshots on ticket #5.

**On disk**, and this is the real record:

```
state/runs/<iid>/run.json                     the journal: every phase, lap, status, spend
state/runs/<iid>/transcripts/<phase>.jsonl    every message of every phase
state/runs/<iid>/artifacts/                   screenshots, demo, reports
state/memory/                                 cards, so the next similar ticket starts warm
```

**In Langfuse:** one trace per run, one span per phase, with models and real
token counts.

```sh
npm run langfuse -- 6      # re-export one run (idempotent)
npm run langfuse           # backfill everything on disk
```

Worth knowing: the CLI's own OpenTelemetry **does not work through the Agent
SDK** — measured, not assumed. A session spawned by `query()` exports nothing
while the identical environment spawned as `claude -p` exports every time, and
it is not a flush race. So the conductor writes the trace itself from the
journal. You lose per-tool-call spans; you keep the run, the phases, the
timings, the models and the spend.

---

## Safety, and what it will not do

- `merge` and `close` are **code, not models** — no session holds a merge tool.
- `deploy` is a session, but caged: `hooks/deploy-guard.cjs` fails **closed** and
  allows only allowlisted hosts and remote verbs. Afterwards the conductor
  re-derives the deployed SHA itself and **overrules** the phase unless it
  contains this run's merge SHA and the site answers 200.
- `git-guard` forbids force-push, pushes to protected branches, and pushes to
  any ref but this run's leased branch.
- A `verify` that passes **no** cases hard-stops the run rather than riding a
  clean-looking card toward a merge.
- `qa` returns `fail` for any high-blast failure, for a reproducible failure in
  behaviour the change touched, and whenever it cannot tell. Only narrow,
  low-blast, describable defects — and anything in behaviour the ticket never
  touched — become `followUps` posted to the ticket instead of blocking.
- `state/PAUSE` freezes everything, including sessions already mid-phase.
  Nothing automatic ever removes it.
- `DRY_RUN=1 npm start` runs every phase and refuses every write.

**Do not `git add -A` in this repo while a run is in flight.** Phases write
scratch at the conductor root — a Bash redirect escapes `write-scope`, which
only guards the `Write`/`Edit` tools — and a session-state file was once
committed to a public repo this way. The patterns are gitignored now; stage
deliberately anyway.

---

## Concurrency

`config/project.json` sets `concurrency: 2`. Tickets pipeline freely, but the
`merge → deploy → qa` window is held by **one run at a time** via
`src/lib/promotion.ts` — the deploy ships a branch *tip*, so two runs merging
into `dev` inside that window would make neither QA verdict attributable. The
upper bound is the port pool (`PORT_POOL`, 3 by default).

---

## If you change something

```sh
npm run check          # tsc + syntax-check every guard
npm run hooks:verify   # 89 offline guard assertions, no network
npm run doctor         # auth, config, paths, GitLab, deploy target
npm run preflight      # everything above plus live credentials and stale state
```

`tsx` compiles at process start, so a running conductor keeps executing the code
it launched with. Edits apply on the **next** launch — which is what makes it
safe to fix something while a run is in flight.
