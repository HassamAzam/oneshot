# Dashboard

`npm run dashboard` serves a live view of the fleet on `http://127.0.0.1:8787`.
On a server it runs as `oneshot-dashboard.service` on `0.0.0.0:8787`, behind
the token, and is opened by IP from the office network. It loads nothing from
the internet, so it works on a LAN with no outbound access.

| Route | What it shows |
|---|---|
| `/` | The fleet strip, then every ticket in three lists: **In flight**, **Waiting on a person**, **Finished** (last 24h; 3, 7 or 30 days from the menu, or `?hours=N`). Polls `/api/state` every 10s and again when the tab comes back into view. |
| `/api/state` | The same data as JSON. Takes `?hours=N` (1–720). |
| `/run/:iid` | One run: where it stands and for how long, the MR, a line per phase (laps, time, turns, input/output/cache-read and weighted tokens), the last 25 transcript lines, and every attempt and recent event under a fold. `?run=<runId>` opens an older run of the same ticket. Reloads every 30s while the run is moving. |
| `/run/:iid/report` | The full transcript report (agents, tool calls). Slow on a long run: it parses every transcript. |
| `/run/:iid/tail` | The last 80 lines of the newest transcript, as one-liners. |
| `/stats` | History over the last 7, 30 or 90 days or all time (`?days=7\|30\|90\|0`): tickets merged, success rate, cycle time, tokens, merged and tokens per day, a line per phase (attempts, laps per run, first-try pass rate, failures, parked runs, median time, tokens), and where blocked runs stopped. Refreshes every 5 minutes. |
| `/api/stats` | The same as JSON, with the same `?days=`. |
| `/runs` | Every run journal, archived ones included. `/run/:iid?archived=<dir>` opens an archived run's saved report. |

## The fleet strip

- **Slots**: runs a live conductor is driving, out of `ONESHOT_CONCURRENCY` (or `concurrency` in `config/project.json`).
- **Run window**: open or closed by `ONESHOT_WINDOW` (default `10-22`, `always` to switch it off), with the next hour it opens or closes. Uses the same rule as `scripts/window.sh`, in the server's local time.
- **Quota**: "standing down" while `state/PAUSE-QUOTA` is in force (a subscription usage limit was hit), with the time it lifts. Otherwise the weighted tokens spent in the last 5h and today, the account's 5h usage when the status-line harvester is fresh, and the last quota park if it was within a day.
- **Conductors**: how many are alive (a heartbeat within 60s).
- **Paused**: only shown when a `state/PAUSE*` kill switch is present.

## Ticket status

The runs table only stores claimed / running / parked / blocked / done / aborted. The board reads them as follows (`src/lib/fleetview.ts`):

| Shown as | When |
|---|---|
| running / starting | claimed or running, and a live conductor owns it (starting: no phase has begun yet) |
| quota stand-down | claimed or running, no live owner, and the quota park is in force |
| waiting for window | claimed or running, no live owner, and outside `ONESHOT_WINDOW` |
| stalled | claimed or running, no live owner, inside the window, no quota park. The next conductor to tick resumes it; if one doesn't, look into it. |
| on a gate | parked: a person has to approve, answer or merge (the reason is shown) |
| blocked | blocked, with its reason |
| done / aborted | finished |

**For** is how long the ticket has been in its current state: since the open phase started while it runs, or since it stopped while it waits. When a ticket has been run more than once, only its newest run is listed. The issue and MR links are full GitLab URLs, taken from the run journal or built from `GITLAB_REPO_URL`.

The database is opened read-only, and nothing here imports the modules that open it read-write. Every string drawn from it, from a journal or from a transcript goes through the same `redact()` the reports use.

## Stats

`/stats` reads the tables the conductor already keeps: `runs`, `phase_runs`, `quota_usage` and `events`. Nothing on the server prunes them, so the history is kept as long as `state/oneshot.db` is kept, across restarts and redeploys. Nothing is copied or cached elsewhere, so if you delete or replace the database the history goes with it. Back it up with `sqlite3 state/oneshot.db ".backup <file>"` if it matters.

- **Success rate** is merged ÷ (merged + blocked + aborted), over runs started in the period. Parked and in-flight runs aren't counted yet.
- **Cycle time** is a merged run's start to its end, gates included.
- **Attempts** leave out `parked` rows, and count a model-less phase (such as `mr-open` or `merge`) repeating the same result for the same run once. Both come from the conductor re-checking a parked run every tick, not from real attempts.
- **First try** is the share of runs whose first real attempt at the phase passed (`ok`, `warned` or `skipped`).
- Days are the server's local days. The daily charts show at most the last 90 days.

## Settings

| Env | Default | |
|---|---|---|
| `ONESHOT_DASHBOARD_PORT` | `8787` | |
| `ONESHOT_BOARD_URL` | unset | Adds a Telemetry ↗ link in the fleet header pointing at the board. |
| `ONESHOT_DASHBOARD_HOST` | `127.0.0.1` | Any non-loopback host needs a token, or the server refuses to start. |
| `ONESHOT_DASHBOARD_TOKEN` | unset | When set, every request needs it: as the Basic-auth password (any username), or once as `?token=…`, which sets a cookie and redirects to the same URL without it. |
| `ONESHOT_CONCURRENCY` | project.json | The slot count. |
| `ONESHOT_WINDOW` | `10-22` | The run window, as `scripts/window.sh` reads it. |

The pages quote run journals and transcripts, which have carried credentials
before. Only serve them off the machine behind the token, and preferably behind TLS.
