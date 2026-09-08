# Handoff — running Oneshot

Everything needed to take a GitLab ticket from the `Loop` label to
`Ready For Deployment` without anyone watching. Ticket #5 went the whole way on
2026-08-27; that run needed about a dozen human interventions, and this document
exists because each one of them is now either automated or written down.

New machine? Start at **Set it up**. Already running? **Run it** is the whole of
it, and the rest is for when something stops.

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

## Set it up

Skip to **Run it** if this machine already has a working `.env`.

### What arrives separately

Never commit these; they belong in `.env` and nowhere else.

| Value | What it is |
|---|---|
| `GITLAB_TOKEN` | project access token — reads tickets, opens and merges MRs |
| `BOARD_INGEST_TOKEN` | 64 hex characters; the telemetry board's write credential |
| `WORK_REPO`, `CONTEXT_REPO`, `ONESHOT_GITLAB_PROJECT` | which repos, and where they are on *your* disk |
| `SLACK_BOT_TOKEN` | optional — progress cards. Oneshot runs without it |
| a board login | separate from the ingest token; ask for one |

### 1. Prerequisites

```sh
node --version      # >= 20
git --version
claude --version
```

**FortiClient must be connected.** GitLab and the demo box are on a gated subnet,
and `npm install` itself can fail without it.

> If `npm install` hangs with `ETIMEDOUT` while `curl` to the same host works, Node
> is resolving `registry.npmjs.org` to IPv6 addresses the VPN black-holes. Force
> IPv4: `NODE_OPTIONS="--require $PWD/scripts/ipv4-dns.cjs" npm install`,
> or tether for the install.

### 2. Sign in as yourself

```sh
claude login
python3 -c "import json,os;print(json.load(open(os.path.expanduser('~/.claude.json')))['oauthAccount']['emailAddress'])"
```

If that prints somebody else's address, you are spending their subscription. Board
attribution is unaffected — a desk is identified by its OS username precisely so a
shared account cannot make two people post as one — but the bill is not.

### 3. Clone and install

```sh
git clone https://github.com/HassamAzam/oneshot.git ~/Documents/oneshot
cd ~/Documents/oneshot && npm install
```

`WORK_REPO` (what Oneshot commits to) and `CONTEXT_REPO` (read for prior art) must
also exist on disk.

### 4. Configure

```sh
npm run setup
```

An interactive wizard; every prompt has a working default, and `npm start` runs it
automatically when there is no `.env`. It writes `.env` at mode 600 and offers to
install the guardrail hooks into `~/.claude/settings.json` — **say yes**. Those hooks
are what stop a phase pushing to a protected branch or reaching a host it should not.

Then paste in the values you were sent. If you were handed a whole `.env`, check
these three point at **your** home directory — a copied path is the most common way
a working config fails:

```
ONESHOT_HOME=/Users/<you>/Documents/oneshot
WORK_REPO=/Users/<you>/Documents/<work repo>
WT_ROOT=/Users/<you>/Documents/oneshot-wt
```

Add the board, two lines in the same file:

```
BOARD_URL=https://oneshot-board.vercel.app
BOARD_INGEST_TOKEN=<the 64-character token>
```

Leave `BOARD_OPERATOR` blank — your identity resolves to your OS username.

### 5. Verify before spending anything

```sh
npm run doctor         # auth, GitLab, paths, deploy target, hooks
npm run board:doctor   # identity, transcripts, board reachability, the collector
```

Fix what they report and re-run until both are clean. Each failure prints its own
fix on the next line.

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
| Nothing of yours on the board | The collector is not running — it is a separate process from `npm start` | `npm run board:doctor`; then `npm run board` | no — nothing is running to heal it |
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

**On the telemetry board** (https://oneshot-board.vercel.app): every session, the
subagents and skills each one called, every tool call with its input and output, and
the complete transcript — filterable by whose desk it ran on.

```sh
npm run board          # the daemon: notices new work in 5s, posts every 60s
npm run board:once     # one pass, then exit
npm run board:doctor   # why is this desk not on the board?
```

**The conductor and the collector are separate processes.** `npm start` produces
transcripts; the collector ships them. Restarting the loop does not start the
collector — that is the single most common reason a desk shows nothing.

The collector only reads `state/`, holds unsent rows in a local outbox so an offline
laptop loses nothing, and refuses to start if another instance is already running
against the same state directory. To survive a reboot, install it as a login item:

```sh
NODE=$(which node); cat > ~/Library/LaunchAgents/com.oneshot.board.collector.plist <<EOT
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.oneshot.board.collector</string>
  <key>ProgramArguments</key><array><string>$NODE</string><string>$HOME/Documents/oneshot/scripts/board/index.mjs</string></array>
  <key>WorkingDirectory</key><string>$HOME/Documents/oneshot</string>
  <key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>/tmp/oneshot-board-collector.log</string>
  <key>StandardErrorPath</key><string>/tmp/oneshot-board-collector.log</string>
</dict></plist>
EOT
launchctl load ~/Library/LaunchAgents/com.oneshot.board.collector.plist
```

Why a board and not Langfuse: Claude Code's own telemetry anonymises user-defined
subagents to the literal string `custom`, so `backend-agent` and `qa-agent` are
indistinguishable in it — and the CLI's OpenTelemetry does not emit the tool span
tree through the Agent SDK at all (measured: `query()` exports nothing where the
identical environment as `claude -p` exports every time; upstream closed it as not
planned). The transcripts on disk carry the real names, so the board is built from
those instead.

---

## Reading a transcript

A transcript is the complete record of one phase: every message in and out, every tool
call with its real arguments and its real output. It is the only place that says what
actually happened, and it is where nearly every diagnosis ends up.

```
state/runs/<iid>/transcripts/<phase>-lap<n>.jsonl
```

One JSON object per line, in order. Four line types matter:

| `type` | What it is |
|---|---|
| `system` (`subtype: init`) | the session opening: model, cwd, which tools and MCP servers it was given |
| `assistant` | what the model produced — text, and `tool_use` blocks with the exact arguments |
| `user` | what the harness fed back — `tool_result` blocks with the real output |
| `result` | the closing verdict: `subtype`, `num_turns`, `duration_ms`, the final message |

That alternation *is* the agent loop: the model asks for a tool, the harness runs it,
the output comes back, repeat. A `parent_tool_use_id` on a line means it happened
inside a subagent rather than the main session.

### The fastest way

**Open the session on the board.** It renders the same file with the tool calls
threaded, subagent lines tinted and labelled with which agent produced them, and raw
JSON one click away per line. The Activity tab is the sequence of actions; the
Transcript tab is the verbatim record.

### At the terminal

Start at the end, because the verdict is there:

```sh
T=state/runs/8/transcripts/research-lap0.jsonl
tail -1 $T | python3 -m json.tool | head -20        # how it ended
grep -c . $T                                        # how long it ran
```

Then the shape of the work:

```sh
# every tool call, in order
grep -o '"name":"[A-Za-z]*","input"' $T | cut -d'"' -f4 | uniq -c

# which subagents and skills were used
grep -o '"subagent_type":"[^"]*"' $T | cut -d'"' -f4 | sort | uniq -c
grep -o '"skill":"[^"]*"'         $T | cut -d'"' -f4 | sort | uniq -c

# what it said, without the tool noise
python3 -c "
import json,sys
for l in open('$T'):
    d=json.loads(l)
    for b in (d.get('message',{}).get('content') or []):
        if isinstance(b,dict) and b.get('type')=='text': print(b['text'][:400],'\n---')
"
```

### Reading the numbers

Every `assistant` line carries a `usage` block, and it does not mean what it looks
like. The model is stateless, so **every turn re-sends the whole conversation**:

- `cache_read_input_tokens` — the context re-read this turn. The real size number, and
  it grows every turn. Climbing fast means a tool is dumping bulk into the context.
- `input_tokens` — only the genuinely new bytes. Near zero is *good*: caching is working.
- `output_tokens` — what the model actually wrote. The one that costs.

### Three shapes worth recognising

| What you see | What it means |
|---|---|
| Many turns, tiny duration | A crash loop, not hard work. 120 turns in 5 seconds is auth failing and retrying — read the first `assistant` line and it will say so |
| `cache_read` exploding | A tool is dumping huge output into the context; the phase will hit its cap on volume, not difficulty |
| Few turns, hit the cap | Genuinely hard, or stuck re-reading the same files. Raise `maxTurns` only after reading why |

The first row is the one that misleads. `error_max_turns` reads like "the task was too
hard, raise the cap" — but a phase that burned 120 turns in five seconds never ran at
all, and the cap is not the problem.

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
npm run board:doctor   # identity, transcripts, board reachability, the collector
```

`tsx` compiles at process start, so a running conductor keeps executing the code
it launched with. Edits apply on the **next** launch — which is what makes it
safe to fix something while a run is in flight.
