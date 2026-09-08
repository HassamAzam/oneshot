# Running Oneshot on your machine

Hand this to Claude Code and work through it in order. Every step verifies before the
next one; when something fails, the tool that found it prints the fix.

Oneshot takes a GitLab issue labelled `Loop` and drives it — unattended — through
research, planning, implementation, review, browser verification, MR, merge, deploy,
QA and documentation. It runs entirely on your machine, on your Claude subscription.
Everything it does is recorded to the shared **Oneshot Board**
(https://oneshot-board.vercel.app), so the team can see which agents and skills ran,
what they cost, and read any transcript.

## What Hassam sends you separately

Never commit these, never paste them outside `.env`:

| Value | Goes in | What it is |
|---|---|---|
| `GITLAB_TOKEN` | `.env` | GitLab PAT — reads tickets, opens and merges MRs |
| `SLACK_BOT_TOKEN` | `.env` | posts run progress; optional, Oneshot runs without it |
| `BOARD_INGEST_TOKEN` | `.env` | 64 hex characters — the board's write credential |
| project paths / IDs | `.env` | `WORK_REPO`, `CONTEXT_REPO`, `ONESHOT_GITLAB_PROJECT` and friends |
| a board login | — | separate from the token; ask him to create one for you |

## Standing authorization — do not stop to ask

- Install prerequisites, clone the repos, run `npm install`.
- Create and edit `.env` in this checkout; run any `npm run` script here.
- Start and stop the conductor and the collector.

## Do not

- **Do not** commit `.env` or any token. It is gitignored — keep it that way.
- **Do not** run Oneshot against a repo that is not `WORK_REPO`.
- **Do not** write into `state/` by hand. It is the run journal; `npm run unblock`
  is the supported way to repair it.
- **Do not** share `BOARD_INGEST_TOKEN` outside the team.

---

## 1. Prerequisites

```bash
node --version      # must be >= 20
git --version
claude --version    # Claude Code CLI
```

Missing Node: install 20 or newer (`brew install node`). Missing Claude Code: see
https://claude.com/claude-code.

You also need the **FortiClient VPN connected** — GitLab and the demo server are on a
gated subnet, and `npm install` itself can fail without it.

> **If `npm install` hangs with `ETIMEDOUT`:** Node resolves `registry.npmjs.org` to
> IPv6 addresses the VPN black-holes, while `curl` works fine. Force IPv4:
> ```bash
> NODE_OPTIONS="--require $PWD/scripts/ipv4-dns.cjs" npm install
> ```
> That helper ships in the board repo; if you do not have it, `npm config set
> registry https://registry.npmjs.org/ --location project` and retry, or tether.

## 2. Sign in as yourself

```bash
claude login
```

Then confirm it is *you*:

```bash
python3 -c "import json,os;print(json.load(open(os.path.expanduser('~/.claude.json')))['oauthAccount']['emailAddress'])"
```

If that prints someone else's address, you are spending their subscription. Fix it
before running anything.

## 3. Clone and install

```bash
git clone https://github.com/HassamAzam/oneshot.git ~/Documents/oneshot
cd ~/Documents/oneshot
npm install
```

You also need the two working repos on disk — Hassam will tell you which and where.
`WORK_REPO` is the one Oneshot commits to; `CONTEXT_REPO` is read for prior art.

## 4. Configure

There is an interactive wizard, and `npm start` runs it automatically when `.env` is
missing:

```bash
npm run setup
```

Every prompt has a working default; pressing Enter through it produces a valid config
for this machine. It writes `.env` at mode 600 and offers to install the guardrail
hooks into `~/.claude/settings.json` — **say yes**. Those hooks are what stop a phase
pushing to a protected branch or reaching a host it should not.

Then paste in the values Hassam sent you. If he sent a whole `.env`, use it as-is but
check these three are right **for your machine**:

```
ONESHOT_HOME=/Users/<you>/Documents/oneshot
WORK_REPO=/Users/<you>/Documents/<work repo>
WT_ROOT=/Users/<you>/Documents/oneshot-wt
```

A path pointing at his home directory is the most common way a copied `.env` fails.

## 5. Add the telemetry board

Two lines in the same `.env`:

```
BOARD_URL=https://oneshot-board.vercel.app
BOARD_INGEST_TOKEN=<the 64-character token>
```

Leave `BOARD_OPERATOR` blank — your identity resolves to your OS username
automatically. That is deliberate: the alternatives are account identities, and a
shared account would make two desks post as one person.

## 6. Verify before running anything

```bash
npm run doctor
```

It checks the Claude credential, the GitLab token, every path, the deploy config and
the hooks. Fix what it reports and re-run until it is clean. `npm run verify` is the
fuller version (dependencies, hooks, doctor).

Then the board:

```bash
npm run board:doctor
```

Every line should be `✓` except the outbox, which will say there is nothing queued
yet. Failures print their own fix on the next line.

## 7. Run one ticket

1. Put the `Loop` label on a GitLab issue.
2. `npm start`
3. Leave it. It claims the ticket, then works through the phases on its own.

Watch the first minute. Within a phase or two you will see
`state/runs/<iid>/transcripts/recall-lap0.jsonl` appear — that file is what the board
ships.

**To watch without touching anything**, set `DRY_RUN=1` in `.env` first: every phase
runs, every write is refused. A good first run.

## 8. Start the collector

The conductor and the collector are **separate processes**. `npm start` produces
transcripts; the collector ships them. Running the loop does not start the collector.

In a second terminal:

```bash
npm run board:once     # one pass — proves it works
npm run board          # the daemon: notices new work in 5s, posts every 60s
```

`board:once` should end with `flush: shipped N row(s) … {"remaining":0}`.

To survive a reboot, see the `launchctl` block in
[`docs/BOARD-ONBOARDING.md`](BOARD-ONBOARDING.md).

## What "working" looks like

- `npm run doctor` and `npm run board:doctor` are clean
- Your OS username is a chip in the board's operator filter, with a session count
- Opening one of your sessions shows its Activity, Agents, Skills and Transcript tabs
- The ticket eventually carries `Ready For Deployment`

## When it stops

| Symptom | First thing to run |
|---|---|
| A run is `blocked` | `npm run unblock -- <iid>` — prunes the failed lap and hands it back |
| `blocked cooldown` | that is a 60-minute wait; `unblock` clears it now |
| Nothing on the board | `npm run board:doctor` |
| A phase burns all its turns in seconds | almost always auth — check `CLAUDE_CODE_OAUTH_TOKEN` and the transcript |
| Anything else | `npm run doctor`, then read the phase's transcript |

The transcript is the ground truth for every failure. A phase that "failed" in five
seconds with 120 turns did not do hard work — it hit a wall and retried. Read the
file at `state/runs/<iid>/transcripts/<phase>-lap0.jsonl`, or open the session on the
board, which renders the same thing.

`HANDOFF.md` covers operating Oneshot day to day. This document only covers getting
there.
