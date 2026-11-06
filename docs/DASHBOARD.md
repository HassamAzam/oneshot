# Dashboard

`npm run dashboard` serves a live view of the fleet on `http://127.0.0.1:8787`.

| Route | What it shows |
|---|---|
| `/` | Fleet strip (live conductors, `state/PAUSE*` switches, port leases, weighted tokens in the last 5h and today), active runs (claimed / running / parked / blocked) and recently finished runs. Polls `/api/state` every 10s. |
| `/api/state` | The same data as JSON. |
| `/runs` | Every run journal, archived ones included. |
| `/run/:iid` | Phase timeline and recent events from the database, above the transcript report. `?archived=<dir>` opens an archived run. |
| `/run/:iid/tail` | The last 80 lines of the newest transcript, as one-liners. |

The database is opened read-only, and every string drawn from it or from a
transcript goes through the same `redact()` the reports use.

## Settings

| Env | Default | |
|---|---|---|
| `ONESHOT_DASHBOARD_PORT` | `8787` | |
| `ONESHOT_DASHBOARD_HOST` | `127.0.0.1` | Any non-loopback host needs a token, or the server refuses to start. |
| `ONESHOT_DASHBOARD_TOKEN` | unset | When set, every request needs it: as the Basic-auth password (any username), or once as `?token=…`, which sets a cookie and redirects to the same URL without it. |

The pages quote run journals and transcripts, which have carried credentials
before. Serve them off-box only behind the token, and preferably behind TLS.
