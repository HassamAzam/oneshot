# Getting this desk onto the Oneshot Board

The board at **https://oneshot-board.vercel.app** collects what every Oneshot desk
actually did: each session, the subagents and skills it called, every tool call with
its input and output, and the complete transcript. It exists because Claude Code's
own telemetry cannot answer the questions we care about — it anonymises user-defined
subagents to the literal string `custom`, so `backend-agent` and `qa-agent` are
indistinguishable in it. The collector reads the transcripts Oneshot already writes
to `state/runs/<iid>/transcripts/`, where the real names are.

This document is written to be handed to Claude Code, and assumes Oneshot already
runs on this machine. Setting up from scratch instead? Use
[`docs/ONBOARDING.md`](ONBOARDING.md), which covers everything including this.

Work through it in order; each step verifies before moving on.

## Standing authorization — do not stop to ask

- Edit `.env` in this checkout, and run any `npm run board:*` script.
- Start and stop the collector process.
- Read anything under `state/`.

## Do not

- **Do not** commit `.env`, or paste `BOARD_INGEST_TOKEN` anywhere outside `.env`.
  It is a shared write credential.
- **Do not** modify anything under `state/` — the collector is a reader. If a script
  wants to write there, something is wrong.
- **Do not** set `ONESHOT_HOME` to somebody else's checkout.

---

## 1. Sign in to your own Claude account

Check first:

```bash
node -e "console.log(require('os').homedir())" && cat ~/.claude.json | python3 -c "import json,sys; print(json.load(sys.stdin).get('oauthAccount',{}).get('emailAddress'))"
```

If that prints **someone else's** email, you are running on their subscription: their
quota, their bill. Fix it before anything else:

```bash
claude login
```

This does not affect board attribution — the board identifies a desk by its OS
username, precisely so a shared account cannot make two people post as one — but it
does affect who pays for the model usage.

## 2. Configure the board

The collector ships with Oneshot and is configured from this repo's `.env`. Add two
lines (ask Hassam for the token; it is 64 hex characters):

```
BOARD_URL=https://oneshot-board.vercel.app
BOARD_INGEST_TOKEN=<the 64-character token>
```

Leave `BOARD_OPERATOR` blank. Your identity resolves to your OS username
automatically — no `gh`, no configuration.

## 3. Verify before shipping anything

```bash
npm run board:doctor
```

Every line must be `✓` except possibly the outbox. It checks who this desk is,
whether Oneshot has produced transcripts at all, whether the board is reachable and
the token accepted, and whether the collector is running. When a check fails it
prints the fix on the next line — follow that and re-run.

Two failures worth recognising:

| Line | Meaning |
|---|---|
| `✗ 0 transcripts` | Oneshot has not completed a phase in this checkout. There is nothing to ship yet; go to step 6. |
| `✗ token refused` | The token is wrong or truncated. It is 64 characters — easy to lose the last few when copying. |

## 4. Ship what is already there

```bash
npm run board:once
```

One scan, one flush, then it exits. Expect a line like:

```
flush: shipped 143 row(s) in 1 batch(es) {"remaining":0}
```

`remaining: 0` means everything reached the board. If it says `HTTP 401`, the token
does not match. If it says a network error, the rows stay queued locally and nothing
is lost — fix the connection and run it again.

**Tell Hassam at this point.** Your OS username should now appear as a chip in the
board's operator filter, and he can open your sessions and read the transcripts.
That is the proof the pipeline works end to end.

## 5. Keep it running

```bash
npm run board
```

Leave it in a terminal. It notices new transcripts within 5 seconds and posts every
60. It refuses to start if another collector is already running against the same
state directory — two would race on the outbox and the watermark.

To survive a reboot, install it as a login item:

```bash
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

Adjust the path if this checkout is not at `~/Documents/oneshot`.

## 6. Only if you have no transcripts yet

The board can only show work that happened. If `board:doctor` reported `0
transcripts`, Oneshot has not run here. Run one ticket:

1. Complete the rest of `.env` — `GITLAB_TOKEN`, `WORK_REPO`, the paths. See
   `HANDOFF.md`, and `npm run doctor` will tell you what is still missing.
2. Put the `Loop` label on a GitLab issue.
3. `npm start`, and leave it.

The first phase writes `state/runs/<iid>/transcripts/recall-lap0.jsonl` within a
minute or two. Once that file exists the collector has something to ship, and it will
go out on the next 60-second tick.

You do not need a ticket to reach `Ready For Deployment` for the board to be useful —
one completed phase is enough to prove the whole path.

## What "working" looks like

- `npm run board:doctor` is all `✓`
- Your OS username is a chip in the board's operator filter, with a session count
- Clicking one of your sessions shows its Activity, Agents, Skills and Transcript tabs

## When it stops

`npm run board:doctor` first — it diagnoses every failure mode this setup has and
prints the fix. `npm run board:stats` shows what is queued without sending anything.
The collector never deletes from `state/`, so nothing you do here can damage a run.
