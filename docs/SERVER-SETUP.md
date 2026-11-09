# Server setup

One script takes a fresh Ubuntu 22.04 / 24.04 or Debian 12 host to a running Oneshot:
`scripts/setup-server.sh`. It is idempotent. Every step checks first and does nothing when the
host already has what it needs, so re-running it is always safe, and re-running it is also how
you upgrade (`git pull`, then run it again). `--check` only reports what is missing.

```sh
sudo git clone <oneshot repo> /srv/oneshot
sudo /srv/oneshot/scripts/setup-server.sh                      # 1st run: writes the env template, stops
sudo $EDITOR /etc/oneshot/oneshot.env                         # fill in every REPLACE_ME
sudo /srv/oneshot/scripts/setup-server.sh --start             # installs everything, starts services
sudo /srv/oneshot/scripts/setup-server.sh --check             # any time: what is missing, exit 1 if anything
```

Options: `--env-file <path>` (default `/etc/oneshot/oneshot.env`), `--start` (otherwise the units
are only enabled), `--with-cypress` (xvfb and the Cypress system libraries, for the local
automation tests mode), `--skip-apt`, `--refresh-baseline`.

## Before you start: network

`gitlab.arbisoft.com` is network-gated. Off the office network or VPN it answers
`HTTP 403 "RBAC: access denied"` to every request, and the clone and every ticket then fail. The
script tests `https://gitlab.arbisoft.com/api/v4/version` and says so in plain words. If it is
refused, either ask DevOps to allow-list the server, or run the FortiClient tunnel with
`openfortivpn` (`sudo apt-get install -y openfortivpn`, then
`sudo openfortivpn <gateway>:<port> -u <user>`, or as a systemd service with
`/etc/openfortivpn/config`). Note that npm is blocked while some VPN profiles are up: install the
packages first, then bring the tunnel up.

## The env file

`deploy/oneshot.env.example` lists every key and marks which are required. It is copied to
`/etc/oneshot/oneshot.env` (directory 0700, file 0600, owned by `oneshot`). The same file is
read by systemd (`EnvironmentFile=`), by `npm run setup -- --from-env --env-file`, which writes
`/srv/oneshot/.env` from it, and by `scripts/provision-seed.cjs`. Use plain `KEY=value` lines
with absolute paths: systemd expands neither `~` nor `$VAR`.

Required: `GITLAB_REPO_URL`, `ONESHOT_GITLAB_TOKEN` (or `GITLAB_TOKEN`), a Claude subscription credential (either
`CLAUDE_CODE_OAUTH_TOKEN` from `claude setup-token`, or a one-time `sudo -u oneshot -H claude` then
`/login` after install; never `ANTHROPIC_API_KEY`),
`ONESHOT_TEST_LOGIN` (`email:password`), `DB_NAME`, `DB_USER`, `DB_PASSWORD`, and
`ONESHOT_DASHBOARD_TOKEN`. A fresh server also needs `ONESHOT_DB_DUMP`, a `pg_dump` of a dev or
staging database. ERP's migrations do not apply to an empty database (verified: a data migration
reads `core_historicalperson.is_hourly_deel_contractor` before the migration that adds it), so
without a dump the seed's `migrate` step fails. The script refuses to go on while any of them is unset or still says
`REPLACE_ME`, and names them all at once.

On a server every path is explicit, and nothing falls back to `~/Documents`: `WORK_REPO=/srv/erp`,
`ONESHOT_SEED_FROM=/srv/erp`, `WT_ROOT=/srv/erp-wt`, and `CONTEXT_REPO=/srv/erp`.
`ONESHOT_SKILLS_ROOT` and `ONESHOT_SESSION_PATH` are optional.

A 10-ticket server:

```
ONESHOT_CONCURRENCY=10
PORT_POOL=8100-8109
ONESHOT_APP_PORTS=8010-8012
ONESHOT_LOCAL_TESTS_PORT=8030
ONESHOT_LOCAL_TESTS_FE_PORT=9030
ONESHOT_BRINGUP_PARALLEL=2
ONESHOT_PER_RUN_DB=1
ONESHOT_DB_BASELINE=hrdb_baseline
```

Webpack takes each Django port + 1000 (9100-9109), so keep that range free too. Never put a `#`
comment on the same line as a value: systemd keeps it as part of the value.

## What the script does, in order

1. **Env file.** If it is missing, the script writes the template and stops. It also checks
   that every required key is set.
2. **Packages.** It installs `git curl build-essential lsof procps iproute2 postgresql
   postgresql-client redis-server redis-tools memcached libpq-dev unixodbc-dev tesseract-ocr`.
   `wkhtmltopdf` is installed when the release still ships it, and the script warns when it does
   not. Either `lsof` or `ss` (iproute2) is required for port and pid probing (otherwise it fails
   with `E_NO_PROBE`), and both are installed.
3. **Python 3.12.** Ubuntu 24.04 ships it. Ubuntu 22.04 gets it from the deadsnakes PPA. Debian 12
   has only 3.11, so the script builds 3.12 into `/usr/local` (`make altinstall`).
4. **Node 22** from NodeSource's apt repository (signed keyring, not a piped script), and
   **Claude Code**: `npm i -g @anthropic-ai/claude-code`.
5. **User and directories.** It creates the system user `oneshot` (home `/home/oneshot`), then
   `/srv/oneshot`, `/srv/erp`, `/srv/erp-wt`, `/srv/logs`, `/srv/erp-wt/logs` and `/etc/oneshot`
   (0700). The two `logs` directories exist because `hrdb/settings.py` logs to
   `<checkout>/../logs` and Django refuses to start without it.
6. **Postgres.** It sets `max_connections = 300`, because every run gets its own database. It
   creates (or re-syncs) the `DB_USER` role with `LOGIN CREATEDB` and the env file's password,
   creates `DB_NAME`, and restores `ONESHOT_DB_DUMP` only while that database has no tables. The
   dump may be `.sql`, `.sql.gz`, `.dump` (`pg_dump -Fc`) or `.dump.gz`; the format is detected
   from the content.
7. **`~oneshot/.pgpass`** (mode 600). Every `psql` Oneshot runs uses `-w` and never prompts, so the
   password has to come from here (peer/trust auth would also work).
8. **Redis.** It is enabled, with `databases 32`. Run databases use indexes 1 to 10, local tests
   use 15, and 0 is the seed's.
9. **GitLab reachability** (see above).
10. **Oneshot install.** It runs `npm ci` in `/srv/oneshot` as `oneshot`, but only when
    `package-lock.json` has changed (a hash stamp in `node_modules`). Playwright's system
    libraries are installed as root and chromium as `oneshot`, into `PLAYWRIGHT_BROWSERS_PATH`,
    which defaults to `~/.cache/ms-playwright`.
11. **`.env`.** `npm run setup -- --from-env --env-file /etc/oneshot/oneshot.env` writes
    `/srv/oneshot/.env` in one atomic write, at mode 600. It writes nothing when a required key
    is missing.
12. **Seed.** `node scripts/provision-seed.cjs --env-file ...` (see the next section).
13. **Per-run baseline.** `node scripts/app.cjs baseline --refresh --terminate` builds the
    template that per-run databases are copied from, and only when it does not exist yet
    (`--refresh-baseline` forces a rebuild). Per-run databases stay off until this template
    exists.
14. **Oneshot Board**, only with `ONESHOT_BOARD=1` (see *Oneshot Board* below). It clones the
    board to `/srv/oneshot-board` on `BOARD_REF` (default `main`). When an existing checkout is
    on another branch, a normal run fetches `BOARD_REF` and checks it out, and dies if local
    changes block the checkout; `--check` only reports it. A checkout already on `BOARD_REF` is
    not pulled (see *To upgrade the board*). `BOARD_REF` must be a branch name, not a tag or a
    sha: the script compares it with the checkout's branch. It creates `BOARD_MEDIA_DIR`
    (default `/srv/oneshot-board/media`), and creates `BOARD_DB_NAME` (default `oneshot_board`)
    in this Postgres, owned by `DB_USER` and empty. It warns when Postgres listens beyond loopback. It writes `/etc/oneshot/board.env`,
    runs `npm ci` + `next build` (only when the lock file or the board's commit changed), applies
    the board's `db/schema.sql` (idempotent, every pass), warns while the board has no login, and
    prints the `ufw allow` line when ufw is active and the board port is closed.
15. **systemd.** It installs `deploy/systemd/oneshot-conductor.service` and
    `oneshot-dashboard.service`, runs `daemon-reload`, and enables both units. With `--start` it
    also (re)starts them.
16. **Verdict.** It runs `node src/lib/appenv.cjs --env-file ...`, the same checks doctor's
    *Host prerequisites* section runs. It exits 1 on any FAIL and prints the fix line.

## The seed: `scripts/provision-seed.cjs`

The seed is the installed ERP clone that every worktree borrows `venv`, `node_modules`,
`staticfiles` and its two gitignored settings files from. Each step is check, then do, then
verify, and prints one line: `ok` (nothing to do), `did`, or `FAIL` with a `fix:` line. The first
FAIL stops the run.

| Step | Check | Do |
|---|---|---|
| credentials | an https clone is needed and git has no credential for the host | `credential.<origin>.helper store` + `~/.git-credentials` (0600) from the GitLab token |
| clone | `WORK_REPO/.git` exists | `git clone GITLAB_REPO_URL` |
| venv | `venv/bin/python` is 3.12 and `requirements/base.txt` hash = `venv/.oneshot-requirements.sha256` | `python3.12 -m venv venv`, `pip install -r requirements/base.txt` |
| npm | `package-lock.json` hash = `node_modules/.oneshot-lock.sha256` | `npm ci` |
| settings | `hrdb/local_settings.py` equals the rendered template, or is hand-made (left alone) | render `config/erp/local_settings.template.py` (0600) |
| configjs | `frontend/src/constants/config.js` has every key of `config.example.js` | compose it, keeping existing values |
| logs | `<seed>/../logs` and `WT_ROOT/logs` exist (hrdb/settings.py's LOG_ROOT; Django will not start without it) | `mkdir -p` |
| database | `DB_NAME` exists | `CREATE DATABASE` |
| migrate | `migrate --check` passes | `migrate` |
| collectstatic | `staticfiles/staticfiles.json` exists | `collectstatic` |
| testuser | `ONESHOT_TEST_LOGIN` can log in (User, linked Person, active, password) | create/repair the user; a new one is a superuser with a minimal Person |

Flags are `--check` (report only), `--only a,b`, `--skip a,b` and `--env-file`. Python always
starts with `import ssl, hashlib` before Django loads. Without it, this venv writes corrupted
password hashes.

No `/etc/hrdb/settings.ini` is needed. The tracked `hrdb/settings.py` and `hrdb/config.py` never
read it; only a deployed `local_settings.py` does. The generated file carries its values as plain
literals, which is also what `src/lib/rundb.cjs` needs when it re-points each worktree's copy at
its own `oneshot_run_<iid>_<hex>` database and Redis DB. Delete the file's first line
(`# ONESHOT-GENERATED`) to make it yours, and provision-seed will leave it alone from then on.

## Run window

The conductor runs only inside `ONESHOT_WINDOW` (default `10-22`: from 10:00, stopped at 22:00;
`always` turns the window off). `oneshot-window.timer` fires every hour and two minutes after boot,
and `scripts/window.sh apply` starts or stops the conductor to match. A start outside the window
is skipped by the unit's `ExecCondition`, so a reboot at night does not bring it up. The stop is the
usual `SIGTERM`: in-flight runs reach a journal checkpoint and resume when the window opens again.
The dashboard is not windowed.

## Odoo

`ODOO_URL` (the XML-RPC endpoint, e.g. `http://host:8069/xmlrpc/2`), `ODOO_DB`, `ODOO_USERNAME` and
`ODOO_PASSWORD` go into the generated `hrdb/local_settings.py`. `USE_ODOO` is `True` only when all
four are set. Re-run `node scripts/provision-seed.cjs --only settings --env-file ...` after changing them.

## Oneshot Board

The telemetry board (github.com/HassamAzam/oneshot-board) can run on this server instead of
Vercel + Supabase. It shows sessions, agents, skills, tool calls, transcripts, interventions,
screenshots and videos, and the long-run stats. Its data lives in this server's Postgres in its
own database, which starts empty: the board records from the day it is installed.

The collector and the board share this machine and this Postgres. The collector writes
straight to the board's database, so there is no network write path and no ingest token. The
only port the LAN sees is the board's `:3100`, behind its own logins. Postgres stays on
loopback (Ubuntu's default); the setup script warns if `listen_addresses` is anything else.

In `/etc/oneshot/oneshot.env`:

```sh
ONESHOT_BOARD=1
BOARD_SESSION_SECRET=<openssl rand -hex 32>
BOARD_REF=self-host        # a branch name, not a tag or sha; only while it is unmerged; default main
# optional: BOARD_PORT=3100  BOARD_DB_NAME=oneshot_board  BOARD_RETENTION_DAYS=90
#           BOARD_MEDIA_DIR=/srv/oneshot-board/media  BOARD_OPERATOR=server-1
```

Re-run the setup script, add a login (the first one is the admin; it prompts for the
password), and open the port if ufw is on:

```sh
sudo /srv/oneshot/scripts/setup-server.sh --start
sudo -u oneshot -H bash -c 'cd /srv/oneshot-board/web && set -a && . /etc/oneshot/board.env && npm run user:add -- <username>'
sudo ufw allow 3100/tcp
```

Open `http://<server-ip>:3100`. The script writes `/etc/oneshot/board.env` (mode 600) from the
main env file: `DATABASE_URL` and `BOARD_DATABASE_URL` (the same `127.0.0.1` URL, built from
`DB_USER`/`DB_PASSWORD`), `SESSION_SECRET`, `RETENTION_DAYS`, `PORT`, `BOARD_MEDIA_DIR`,
`FLEET_URL` (the fleet dashboard on this host, `:8787`) and `BOARD_OPERATOR`. Edit the main
file and re-run; never this one. Two units run it:

- `oneshot-board`: `next start` on `0.0.0.0:$BOARD_PORT`. It prunes old transcript lines and
  tool bodies once a day (`RETENTION_DAYS`) and serves media from `BOARD_MEDIA_DIR`.
- `oneshot-board-collector`: `scripts/board/index.mjs` in `/srv/oneshot`. It runs all day, not
  just inside the run window, and writes `state/` to the board's database every 60s.

To upgrade the board:

```sh
sudo -u oneshot -H bash -c 'git -C /srv/oneshot-board fetch && git -C /srv/oneshot-board checkout <BOARD_REF> && git -C /srv/oneshot-board pull'
sudo /srv/oneshot/scripts/setup-server.sh
```

The script rebuilds, applies the schema and restarts. The board's history is the
`oneshot_board` database plus the media directory. Back up both:

```sh
sudo -u postgres pg_dump -Fc oneshot_board > board.dump
sudo tar -C /srv/oneshot-board -czf board-media.tgz media
```

If the repo is private, the clone needs credentials. Clone it once as `oneshot` and the script
uses that checkout:
`sudo -u oneshot -H git clone --branch <BOARD_REF> <url> /srv/oneshot-board`.

## Disk

A blocked or parked run keeps its database copy, about one baseline each, until the run finishes
or `rundb sweep --drop` removes it. Size the disk for the concurrency plus the parked runs you
expect, and prefer a copy-on-write filesystem for `/var/lib/postgresql` (XFS with
`reflink=1`, or Btrfs). There, `CREATE DATABASE ... TEMPLATE` copies are cheap.

## Day two

```sh
sudo systemctl status oneshot-conductor oneshot-dashboard oneshot-board oneshot-board-collector
journalctl -u oneshot-conductor -f
sudo -u oneshot -H bash -c 'cd /srv/oneshot && npm run doctor'
sudo -u oneshot -H bash -c 'cd /srv/oneshot && node scripts/app.cjs rundb status'
sudo -u oneshot -H bash -c 'cd /srv/oneshot && node scripts/app.cjs rundb sweep'     # add --drop to delete
sudo /srv/oneshot/scripts/setup-server.sh --check
```

The conductor unit stops with `SIGTERM`, `KillMode=mixed` and `TimeoutStopSec=2h`, so a restart
lets in-flight runs reach a journal checkpoint first. Runs resume from their journals at the next
boot. The dashboard listens on `0.0.0.0:${ONESHOT_DASHBOARD_PORT:-8787}` and refuses to start
without `ONESHOT_DASHBOARD_TOKEN`. Put it behind the firewall or a reverse proxy with TLS.
