#!/usr/bin/env bash
# Oneshot server setup — Ubuntu 22.04 / 24.04, Debian 12. Idempotent: every step
# checks first and does nothing when the host already has it, so re-running is
# always safe (and is how you upgrade: git pull, then run it again).
#
#   sudo scripts/setup-server.sh [--env-file /etc/oneshot/oneshot.env] [--start]
#                                [--with-cypress] [--skip-apt]
#   scripts/setup-server.sh --check [--env-file ...]     report only, change nothing
#
# Run it from the Oneshot checkout at ONESHOT_DIR (default /srv/oneshot).
# docs/SERVER-SETUP.md is the walkthrough; deploy/oneshot.env.example lists every key.
set -euo pipefail

ENV_FILE=/etc/oneshot/oneshot.env
CHECK=0
START=0
WITH_CYPRESS=0
SKIP_APT=0
REFRESH_BASELINE=0
ORIG_ARGS=("$@")
SELF_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ONESHOT_DIR="${ONESHOT_DIR:-/srv/oneshot}"
SVC_USER=oneshot
SVC_HOME=/home/oneshot
NODE_MAJOR=22
PG_MAX_CONNECTIONS=300
REDIS_DATABASES=32
PY=python3.12
PY_SOURCE_VERSION=3.12.12

usage() {
  sed -n '2,11p' "$0" | sed 's/^# \{0,1\}//'
  cat <<'EOF'

Options:
  --env-file PATH   the server env file (default /etc/oneshot/oneshot.env)
  --check           report what is missing; change nothing; exit 1 if anything is
  --start           (re)start the services at the end (default: enable only)
  --with-cypress    also install xvfb and the Cypress system libraries
  --skip-apt        skip package installation (already provisioned hosts)
  --refresh-baseline rebuild the per-run template DB even when it exists
  -h, --help        this text
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --env-file) ENV_FILE="${2:?--env-file needs a path}"; shift 2 ;;
    --check) CHECK=1; shift ;;
    --start) START=1; shift ;;
    --with-cypress) WITH_CYPRESS=1; shift ;;
    --skip-apt) SKIP_APT=1; shift ;;
    --refresh-baseline) REFRESH_BASELINE=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown option: $1" >&2; usage >&2; exit 2 ;;
  esac
done

if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then
  G=$'\e[32m' Y=$'\e[33m' R=$'\e[31m' B=$'\e[1m' X=$'\e[0m'
else
  G='' Y='' R='' B='' X=''
fi
MISSING=0
step() { printf '\n%s==> %s%s\n' "$B" "$*" "$X"; }
ok()   { printf '  %sok%s    %s\n' "$G" "$X" "$*"; }
did()  { printf '  %sdid%s   %s\n' "$G" "$X" "$*"; }
due()  { printf '  %sdue%s   %s\n' "$Y" "$X" "$*"; MISSING=$((MISSING + 1)); }
warn() { printf '  %swarn%s  %s\n' "$Y" "$X" "$*"; }
die()  { printf '  %sFAIL%s  %s\n' "$R" "$X" "$1" >&2; [ -n "${2:-}" ] && printf '        fix: %s\n' "$2" >&2; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }
svc() {
  local action="$1" name="$2"
  if have systemctl && [ -d /run/systemd/system ]; then
    if [ "$action" = start ]; then systemctl enable --now "$name" >/dev/null 2>&1; else systemctl restart "$name"; fi
  else
    service "$name" "$action" >/dev/null
  fi
}

# ------------------------------------------------------------------ env file

is_placeholder() { case "$1" in ""|*REPLACE_ME*) return 0 ;; *) return 1 ;; esac; }

# Parse KEY=value lines without sourcing (values may hold $, quotes, spaces).
declare -A CFG=()
load_env() {
  local line key val
  while IFS= read -r line || [ -n "$line" ]; do
    line="${line#"${line%%[![:space:]]*}"}"
    case "$line" in ''|'#'*) continue ;; esac
    line="${line#export }"
    key="${line%%=*}"
    [[ "$key" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] || continue
    val="${line#*=}"
    if [[ "$val" =~ ^\"(.*)\"$ ]] || [[ "$val" =~ ^\'(.*)\'$ ]]; then val="${BASH_REMATCH[1]}"; fi
    CFG["$key"]="$val"
  done < "$1"
}
cfg() { local v="${CFG[$1]:-}"; if is_placeholder "$v"; then printf '%s' "${2:-}"; else printf '%s' "$v"; fi; }

step "Env file $ENV_FILE"
if [ ! -f "$ENV_FILE" ]; then
  if [ "$CHECK" = 1 ]; then
    due "$ENV_FILE does not exist — copy deploy/oneshot.env.example there and fill it in"
  else
    install -d -m 0700 "$(dirname "$ENV_FILE")"
    install -m 0600 "$SELF_ROOT/deploy/oneshot.env.example" "$ENV_FILE"
    die "wrote a template to $ENV_FILE — fill in every REPLACE_ME, then re-run" "\$EDITOR $ENV_FILE"
  fi
else
  load_env "$ENV_FILE"
  perms="$(stat -c '%a' "$ENV_FILE" 2>/dev/null || stat -f '%Lp' "$ENV_FILE")"
  [ "$perms" = 600 ] || [ "$perms" = 400 ] || warn "$ENV_FILE is mode $perms — it holds secrets; chmod 600"
  missing=()
  for k in GITLAB_REPO_URL ONESHOT_TEST_LOGIN DB_NAME DB_USER DB_PASSWORD ONESHOT_DASHBOARD_TOKEN; do
    is_placeholder "${CFG[$k]:-}" && missing+=("$k")
  done
  if is_placeholder "${CFG[ONESHOT_GITLAB_TOKEN]:-}" && is_placeholder "${CFG[GITLAB_TOKEN]:-}"; then
    missing+=("ONESHOT_GITLAB_TOKEN (or GITLAB_TOKEN)")
  fi
  if is_placeholder "${CFG[CLAUDE_CODE_OAUTH_TOKEN]:-}"; then
    warn "CLAUDE_CODE_OAUTH_TOKEN unset — the oneshot user must log in once after install: sudo -u oneshot -H claude, then /login"
  fi
  case "$(cfg ONESHOT_TEST_LOGIN)" in *:*|'') ;; *) missing+=("ONESHOT_TEST_LOGIN must be email:password") ;; esac
  if [ ${#missing[@]} -gt 0 ]; then
    if [ "$CHECK" = 1 ]; then due "unset or placeholder in $ENV_FILE: ${missing[*]}"
    else die "unset or placeholder in $ENV_FILE: ${missing[*]}" "edit $ENV_FILE (deploy/oneshot.env.example documents each key)"; fi
  else
    ok "every required key is set"
  fi
fi

WORK_REPO="$(cfg WORK_REPO /srv/erp)"
SEED="$(cfg ONESHOT_SEED_FROM "$WORK_REPO")"
WT_ROOT="$(cfg WT_ROOT /srv/erp-wt)"
DB_NAME="$(cfg DB_NAME hrdb)"
DB_USER="$(cfg DB_USER oneshot)"
DB_PASSWORD="$(cfg DB_PASSWORD)"
DB_PORT="$(cfg DB_PORT 5432)"
DB_DUMP="$(cfg ONESHOT_DB_DUMP)"
DB_HOST="$(cfg DB_HOST 127.0.0.1)"
DB_BASELINE="$(cfg ONESHOT_DB_BASELINE "${DB_NAME}_baseline")"
PER_RUN_DB="$(cfg ONESHOT_PER_RUN_DB)"
REPO_URL="$(cfg GITLAB_REPO_URL)"
BOARD="$(cfg ONESHOT_BOARD)"
BOARD_DIR=/srv/oneshot-board
BOARD_ENV="$(dirname "$ENV_FILE")/board.env"
BOARD_PORT="$(cfg BOARD_PORT 3100)"
BOARD_DB="$(cfg BOARD_DB_NAME oneshot_board)"
BOARD_REPO="$(cfg BOARD_REPO_URL https://github.com/HassamAzam/oneshot-board.git)"
BOARD_REF="$(cfg BOARD_REF main)"
BOARD_MEDIA_DIR="$(cfg BOARD_MEDIA_DIR /srv/oneshot-board/media)"
for ident in "$DB_NAME" "$DB_USER" "$DB_BASELINE" "$BOARD_DB"; do
  [[ "$ident" =~ ^[a-z_][a-z0-9_]*$ ]] || die "DB_NAME/DB_USER '$ident' is not a plain lower-case identifier" "use letters, digits and _"
done
for p in "$WORK_REPO" "$SEED" "$WT_ROOT" "$BOARD_MEDIA_DIR"; do
  case "$p" in /*) ;; *) die "path '$p' is not absolute (systemd does not expand ~)" "use absolute paths in $ENV_FILE" ;; esac
done

# ---------------------------------------------------------------- platform

step "Platform"
if [ "$CHECK" = 0 ] && [ "$(id -u)" != 0 ]; then
  die "must run as root (or with sudo) to install packages and services" "sudo $0 ${ORIG_ARGS[*]:-}"
fi
OS_ID=unknown OS_VER=unknown
if [ -r /etc/os-release ]; then
  # shellcheck disable=SC1091
  . /etc/os-release
  OS_ID="${ID:-unknown}" OS_VER="${VERSION_ID:-unknown}"
fi
case "$OS_ID:$OS_VER" in
  ubuntu:22.04|ubuntu:24.04|debian:12) ok "$OS_ID $OS_VER" ;;
  *) warn "$OS_ID $OS_VER is not a tested platform (Ubuntu 22.04/24.04, Debian 12) — continuing" ;;
esac
[ "$CHECK" = 1 ] && ! have apt-get && warn "no apt-get — package checks below assume Debian/Ubuntu"

# ---------------------------------------------------------------- packages

APT_LOG=/var/log/oneshot-setup-apt.log
export DEBIAN_FRONTEND=noninteractive
apt_get() { apt-get -o Dpkg::Use-Pty=0 "$@" >>"$APT_LOG" 2>&1 || die "apt-get $* failed" "see $APT_LOG"; }
# "hold ok installed" counts: a host that pins a package (Redis 6.2 on 172.30.1.64) has it.
# A versioned Postgres (postgresql-14) satisfies the meta-packages, which would otherwise
# pull the newest major in beside it as a second cluster.
pkg_installed() {
  case "$1" in
    postgresql|postgresql-client)
      dpkg-query -W -f='${Package} ${Status}\n' "$1-[0-9]*" 2>/dev/null | grep -qE ' (install|hold) ok installed$' && return 0 ;;
  esac
  dpkg-query -W -f='${Status}' "$1" 2>/dev/null | grep -qE '^(install|hold) ok installed$'
}
pkg_available() { apt-cache show "$1" >/dev/null 2>&1; }
# First of the candidates apt knows (24.04 renamed several libs to *t64).
apt_pick() { local p; for p in "$@"; do if pkg_available "$p"; then echo "$p"; return 0; fi; done; return 1; }

BASE_PKGS=(git curl ca-certificates gnupg build-essential lsof procps iproute2 postgresql postgresql-client
  redis-server redis-tools memcached libpq-dev unixodbc-dev tesseract-ocr)
OPTIONAL_PKGS=(wkhtmltopdf)
CYPRESS_PKGS=(xvfb libnotify4 libnss3 libxss1 libxtst6 xauth)
CYPRESS_ALTS=("libgtk-3-0t64 libgtk-3-0" "libasound2t64 libasound2" "libgbm1")

step "System packages"
if [ "$SKIP_APT" = 1 ]; then
  ok "skipped (--skip-apt)"
elif ! have dpkg-query; then
  due "dpkg is missing — not a Debian/Ubuntu host"
else
  want=("${BASE_PKGS[@]}")
  if [ "$WITH_CYPRESS" = 1 ]; then
    want+=("${CYPRESS_PKGS[@]}")
    for alts in "${CYPRESS_ALTS[@]}"; do
      # shellcheck disable=SC2086
      p="$(apt_pick $alts || true)"; [ -n "$p" ] && want+=("$p")
    done
  fi
  todo=()
  for p in "${want[@]}"; do pkg_installed "$p" || todo+=("$p"); done
  if [ ${#todo[@]} -eq 0 ]; then ok "${#want[@]} packages installed"
  elif [ "$CHECK" = 1 ]; then due "not installed: ${todo[*]}"
  else
    apt_get update -qq
    apt_get install -y -qq --no-install-recommends "${todo[@]}"
    did "installed ${todo[*]}"
  fi
  for p in "${OPTIONAL_PKGS[@]}"; do
    if pkg_installed "$p"; then ok "$p"
    elif [ "$CHECK" = 1 ]; then warn "$p not installed (optional: PDF export)"
    elif pkg_available "$p"; then apt_get install -y -qq --no-install-recommends "$p"; did "installed $p"
    else warn "$p has no package on $OS_ID $OS_VER — PDF export pages will fail; install a wkhtmltox .deb by hand if a ticket needs them"
    fi
  done
fi

step "Python $PY"
if have "$PY" && "$PY" -c 'import venv, ensurepip' >/dev/null 2>&1; then
  ok "$("$PY" --version) with venv"
elif [ "$CHECK" = 1 ] || [ "$SKIP_APT" = 1 ]; then
  due "$PY with venv/ensurepip is missing"
elif [ "$OS_ID" = ubuntu ]; then
  if ! pkg_available python3.12; then
    apt_get install -y -qq software-properties-common
    add-apt-repository -y ppa:deadsnakes/ppa
    apt_get update -qq
    did "added the deadsnakes PPA"
  fi
  apt_get install -y -qq python3.12 python3.12-venv python3.12-dev
  did "installed python3.12, python3.12-venv, python3.12-dev"
elif pkg_available python3.12; then
  apt_get install -y -qq python3.12 python3.12-venv python3.12-dev
  did "installed python3.12"
else
  # Debian 12 ships 3.11 only and deadsnakes is Ubuntu-only: build 3.12 into /usr/local.
  apt_get install -y -qq --no-install-recommends libssl-dev zlib1g-dev libbz2-dev libreadline-dev \
    libsqlite3-dev libffi-dev liblzma-dev libncursesw5-dev tk-dev uuid-dev xz-utils
  tmp="$(mktemp -d)"
  curl -fsSL "https://www.python.org/ftp/python/$PY_SOURCE_VERSION/Python-$PY_SOURCE_VERSION.tar.xz" -o "$tmp/py.tar.xz"
  tar -xJf "$tmp/py.tar.xz" -C "$tmp"
  (cd "$tmp/Python-$PY_SOURCE_VERSION" && ./configure --prefix=/usr/local --enable-optimizations --with-ensurepip=install >/dev/null \
    && make -j"$(nproc)" >/dev/null && make altinstall >/dev/null)
  rm -rf "$tmp"
  have "$PY" || die "building Python $PY_SOURCE_VERSION did not produce $PY" "install Python 3.12 by hand and re-run"
  did "built Python $PY_SOURCE_VERSION into /usr/local"
fi

step "Node $NODE_MAJOR"
node_major() { node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0; }
if have node && [ "$(node_major)" -ge "$NODE_MAJOR" ]; then
  ok "node $(node --version)"
elif [ "$CHECK" = 1 ] || [ "$SKIP_APT" = 1 ]; then
  due "node >= $NODE_MAJOR missing (have: $(have node && node --version || echo none))"
else
  install -d -m 0755 /etc/apt/keyrings
  curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | gpg --dearmor --yes -o /etc/apt/keyrings/nodesource.gpg
  echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_$NODE_MAJOR.x nodistro main" \
    > /etc/apt/sources.list.d/nodesource.list
  apt_get update -qq
  apt_get install -y -qq nodejs
  did "installed node $(node --version) from NodeSource"
fi

step "Claude Code CLI"
# Current releases are a Bun-built native binary that dies on a CPU without SSE4.2 — a KVM
# guest on the default "Common KVM processor" model, for one. 2.0.77 is the last plain-Node
# cli.js and the version Oneshot's Agent SDK bundles (the SDK runs its own copy, so the
# conductor is unaffected either way); this CLI is only for /login and the doctor check.
CLAUDE_PKG=@anthropic-ai/claude-code
grep -qw sse4_2 /proc/cpuinfo 2>/dev/null || CLAUDE_PKG=@anthropic-ai/claude-code@2.0.77
if have claude && claude --version >/dev/null 2>&1; then ok "claude $(claude --version 2>/dev/null | head -1)"
elif [ "$CHECK" = 1 ] || ! have npm; then due "claude CLI missing or not runnable here — npm i -g $CLAUDE_PKG"
else
  npm i -g --no-fund --no-audit "$CLAUDE_PKG" >/dev/null && did "installed $(claude --version | head -1)"
  [ "$CLAUDE_PKG" = @anthropic-ai/claude-code ] || warn "this CPU has no SSE4.2 — pinned $CLAUDE_PKG (plain Node); ask for CPU passthrough to run current releases"
fi

# ------------------------------------------------------------- user, dirs

step "Service user and directories"
if id "$SVC_USER" >/dev/null 2>&1; then ok "user $SVC_USER"
elif [ "$CHECK" = 1 ]; then due "user $SVC_USER does not exist"
else useradd --system --create-home --home-dir "$SVC_HOME" --shell /bin/bash "$SVC_USER" && did "created user $SVC_USER"
fi
SVC_HOME="$(getent passwd "$SVC_USER" 2>/dev/null | cut -d: -f6 || echo "$SVC_HOME")"
SVC_HOME="${SVC_HOME:-/home/oneshot}"
for d in "$ONESHOT_DIR" "$(dirname "$SEED")" "$WT_ROOT" "$(dirname "$SEED")/logs" "$WT_ROOT/logs"; do
  if [ -d "$d" ]; then ok "$d"
  elif [ "$CHECK" = 1 ]; then due "$d missing"
  else install -d -m 0755 -o "$SVC_USER" -g "$SVC_USER" "$d" && did "created $d"
  fi
done
if [ "$CHECK" = 0 ]; then
  install -d -m 0700 -o "$SVC_USER" -g "$SVC_USER" "$(dirname "$ENV_FILE")"
  chown "$SVC_USER:$SVC_USER" "$ENV_FILE" && chmod 600 "$ENV_FILE"
  chown "$SVC_USER:$SVC_USER" "$WT_ROOT"
  [ -d "$SEED" ] || install -d -m 0755 -o "$SVC_USER" -g "$SVC_USER" "$SEED"
  ok "$(dirname "$ENV_FILE") 0700 and $ENV_FILE 0600, owned by $SVC_USER"
fi
if [ ! -f "$ONESHOT_DIR/package.json" ]; then
  if [ "$CHECK" = 1 ]; then due "$ONESHOT_DIR is not an Oneshot checkout"
  else die "$ONESHOT_DIR is not an Oneshot checkout" "git clone <oneshot repo> $ONESHOT_DIR && sudo $ONESHOT_DIR/scripts/setup-server.sh"; fi
elif [ "$CHECK" = 0 ]; then
  [ "$SELF_ROOT" = "$ONESHOT_DIR" ] || warn "running $SELF_ROOT/scripts/setup-server.sh but installing $ONESHOT_DIR"
  [ -L "$ONESHOT_DIR/node_modules" ] && die "$ONESHOT_DIR/node_modules is a symlink" "remove it; the server needs its own install"
  chown -R "$SVC_USER:$SVC_USER" "$ONESHOT_DIR"
fi

as_svc() { (cd "$ONESHOT_DIR" && runuser -u "$SVC_USER" -- env HOME="$SVC_HOME" PATH="$PATH" NO_COLOR=1 "$@"); }

# ---------------------------------------------------------------- postgres

pg() { runuser -u postgres -- psql -XAtq -v ON_ERROR_STOP=1 "$@"; }

step "Postgres"
if [ "$CHECK" = 1 ] && [ "$(id -u)" != 0 ]; then
  warn "not root: Postgres server settings not inspected (the prerequisite check below still connects as $DB_USER)"
elif ! have psql || ! id postgres >/dev/null 2>&1; then
  due "Postgres server not installed"
else
  if ! pg -c 'SELECT 1' >/dev/null 2>&1; then
    if [ "$CHECK" = 1 ]; then due "Postgres not running"
    else svc start postgresql; did "started Postgres"; fi
  fi
  if pg -c 'SELECT 1' >/dev/null 2>&1; then
    cur="$(pg -c 'SHOW max_connections')"
    if [ "$cur" -ge "$PG_MAX_CONNECTIONS" ]; then ok "max_connections $cur"
    elif [ "$CHECK" = 1 ]; then due "max_connections $cur < $PG_MAX_CONNECTIONS (per-ticket databases)"
    else
      pg -c "ALTER SYSTEM SET max_connections = $PG_MAX_CONNECTIONS" >/dev/null
      svc restart postgresql
      did "max_connections $cur -> $PG_MAX_CONNECTIONS (restarted)"
    fi
    role="$(pg -c "SELECT rolcreatedb FROM pg_roles WHERE rolname = '$DB_USER'")"
    if [ "$CHECK" = 1 ]; then
      if [ "$role" = t ]; then ok "role $DB_USER with CREATEDB"; else due "role $DB_USER missing or lacks CREATEDB"; fi
    else
      verb=ALTER; [ -z "$role" ] && verb=CREATE
      runuser -u postgres -- psql -XAtq -v ON_ERROR_STOP=1 -v pw="$DB_PASSWORD" >/dev/null <<SQL
$verb ROLE $DB_USER WITH LOGIN CREATEDB PASSWORD :'pw';
SQL
      if [ -z "$role" ]; then did "created role $DB_USER (LOGIN CREATEDB)"; else ok "role $DB_USER: LOGIN CREATEDB, password synced from $ENV_FILE"; fi
    fi
    exists="$(pg -c "SELECT 1 FROM pg_database WHERE datname = '$DB_NAME'")"
    if [ "$exists" = 1 ]; then ok "database $DB_NAME"
    elif [ "$CHECK" = 1 ]; then due "database $DB_NAME missing"
    else pg -c "CREATE DATABASE $DB_NAME OWNER $DB_USER" >/dev/null && did "created database $DB_NAME"
    fi
    tables="$(pg -d "$DB_NAME" -c "SELECT count(*) FROM pg_tables WHERE schemaname = 'public'" 2>/dev/null || echo 0)"
    if [ -z "$DB_DUMP" ] && [ "$tables" = 0 ]; then
      warn "$DB_NAME is empty and ONESHOT_DB_DUMP is unset — ERP's migrations do not apply to an empty"
      warn "database (a data migration reads a column a later one adds), so the seed's migrate step will fail."
      warn "Set ONESHOT_DB_DUMP to a pg_dump of a dev/staging database and re-run."
      MISSING=$((MISSING + 1))
    fi
    if [ -n "$DB_DUMP" ]; then
      if [ "$tables" != 0 ]; then ok "database $DB_NAME has $tables tables — dump not restored (only into an empty DB)"
      elif [ ! -r "$DB_DUMP" ]; then
        if [ "$CHECK" = 1 ]; then due "ONESHOT_DB_DUMP $DB_DUMP is not readable"; else die "ONESHOT_DB_DUMP $DB_DUMP is not readable" "fix the path in $ENV_FILE"; fi
      elif [ "$CHECK" = 1 ]; then due "restore $DB_DUMP into empty $DB_NAME"
      else
        reader=(cat "$DB_DUMP"); case "$DB_DUMP" in *.gz) reader=(gzip -dc "$DB_DUMP") ;; esac
        magic="$("${reader[@]}" 2>/dev/null | head -c 5 || true)"
        export PGPASSWORD="$DB_PASSWORD"
        conn=(-h 127.0.0.1 -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME")
        if [ "$magic" = PGDMP ]; then
          "${reader[@]}" | pg_restore --no-owner --no-privileges --exit-on-error "${conn[@]}"
        else
          "${reader[@]}" | psql -XAtq -v ON_ERROR_STOP=1 "${conn[@]}" >/dev/null
        fi
        unset PGPASSWORD
        did "restored $DB_DUMP into $DB_NAME ($([ "$magic" = PGDMP ] && echo custom || echo plain) format)"
      fi
    fi
  fi
fi

step "Passwordless Postgres for $SVC_USER (~/.pgpass)"
PGPASS="$SVC_HOME/.pgpass"
esc() { printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/:/\\:/g'; }
pgpass_line="$(esc "$DB_HOST"):$DB_PORT:*:$(esc "$DB_USER"):$(esc "$DB_PASSWORD")"
if [ -f "$PGPASS" ] && grep -qxF -- "$pgpass_line" "$PGPASS" 2>/dev/null; then ok "$PGPASS has $DB_USER@$DB_HOST:$DB_PORT"
elif [ "$CHECK" = 1 ]; then due "$PGPASS lacks an entry for $DB_USER@$DB_HOST:$DB_PORT (psql runs with -w, never prompting)"
elif ! id "$SVC_USER" >/dev/null 2>&1; then die "user $SVC_USER missing" "re-run without --check"
else
  tmp_pgpass="$(mktemp)"
  { [ -f "$PGPASS" ] && grep -vE "^$(esc "$DB_HOST" | sed 's/[.[\*^$]/\\&/g'):$DB_PORT:\*:$(esc "$DB_USER"):" "$PGPASS" || true; echo "$pgpass_line"; } > "$tmp_pgpass"
  install -m 0600 -o "$SVC_USER" -g "$SVC_USER" "$tmp_pgpass" "$PGPASS"
  rm -f "$tmp_pgpass"
  did "wrote $PGPASS (mode 600)"
fi

# ------------------------------------------------------------------- redis

step "Redis"
REDIS_CONF=/etc/redis/redis.conf
if [ ! -f "$REDIS_CONF" ]; then due "redis-server not installed ($REDIS_CONF missing)"
else
  curdb="$(awk '$1=="databases"{print $2}' "$REDIS_CONF" | tail -1)"
  if [ "${curdb:-16}" -ge "$REDIS_DATABASES" ]; then ok "databases ${curdb}"
  elif [ "$CHECK" = 1 ]; then due "databases ${curdb:-16} < $REDIS_DATABASES"
  else
    if grep -qE '^databases ' "$REDIS_CONF"; then sed -i -E "s/^databases .*/databases $REDIS_DATABASES/" "$REDIS_CONF"
    else echo "databases $REDIS_DATABASES" >> "$REDIS_CONF"; fi
    svc restart redis-server
    did "databases -> $REDIS_DATABASES (restarted)"
  fi
  if redis-cli ping 2>/dev/null | grep -q PONG; then ok "redis answers PONG"
  elif [ "$CHECK" = 1 ]; then due "redis not running"
  else svc start redis-server; did "started redis"
  fi
fi

# ------------------------------------------------------------------ gitlab

step "GitLab reachability"
if [ -z "$REPO_URL" ]; then warn "GITLAB_REPO_URL unset — skipped"
elif ! have curl; then due "curl missing — cannot test GitLab reachability"
else
  origin="$(printf '%s' "$REPO_URL" | sed -E 's#^git@([^:]+):.*#https://\1#; s#^ssh://([^@]+@)?([^/:]+).*#https://\2#; s#^(https?://[^/]+).*#\1#')"
  host="${origin#*://}"
  body="$(curl -sS --max-time 10 -w '\n%{http_code}' "$origin/api/v4/version" 2>&1 || true)"
  code="$(printf '%s' "$body" | tail -n1)"
  case "$code" in
    200|401) ok "$origin answers (HTTP $code)" ;;
    403) if printf '%s' "$body" | grep -qi rbac; then
           warn "$host refuses this network (HTTP 403 \"RBAC: access denied\") — it is VPN-gated (FortiClient)."
           warn "Connect first: sudo apt-get install -y openfortivpn && sudo openfortivpn <gateway>:<port> -u <user>"
           warn "or ask DevOps to allow-list this server. Cloning and every ticket fail until then."
           MISSING=$((MISSING + 1))
         else ok "$origin answers (HTTP 403)"; fi ;;
    *) warn "$host did not answer (HTTP ${code:-000}) — VPN down? DNS? Try: curl -v $origin"
       warn "gitlab.arbisoft.com is FortiClient-gated: openfortivpn, or ask DevOps to allow-list this server."
       MISSING=$((MISSING + 1)) ;;
  esac
fi

# --------------------------------------------------------- as the service user

step "Oneshot install ($ONESHOT_DIR)"
lock_hash() { sha256sum "$1/package-lock.json" | cut -d' ' -f1; }
if [ ! -f "$ONESHOT_DIR/package-lock.json" ]; then due "no package-lock.json in $ONESHOT_DIR"
elif [ -f "$ONESHOT_DIR/node_modules/.oneshot-lock.sha256" ] \
  && [ "$(cat "$ONESHOT_DIR/node_modules/.oneshot-lock.sha256")" = "$(lock_hash "$ONESHOT_DIR")" ]; then
  ok "node_modules matches package-lock.json"
elif [ "$CHECK" = 1 ]; then due "npm ci in $ONESHOT_DIR"
else
  as_svc npm ci --no-audit --no-fund
  lock_hash "$ONESHOT_DIR" | as_svc tee node_modules/.oneshot-lock.sha256 >/dev/null
  did "npm ci"
fi

step "Playwright chromium"
pw_cache="$(cfg PLAYWRIGHT_BROWSERS_PATH "$SVC_HOME/.cache/ms-playwright")"
if ls -d "$pw_cache"/chromium-* >/dev/null 2>&1; then ok "chromium in $pw_cache"
elif [ "$CHECK" = 1 ]; then due "chromium not installed in $pw_cache"
else
  (cd "$ONESHOT_DIR" && npx --no-install playwright install-deps chromium >/dev/null)
  as_svc env PLAYWRIGHT_BROWSERS_PATH="$pw_cache" npx --no-install playwright install chromium
  ls -d "$pw_cache"/chromium-* >/dev/null 2>&1 \
    || die "playwright install finished but no chromium-* is in $pw_cache" "cdn.playwright.dev reachable? (some VPN profiles block it) — re-run"
  did "installed chromium (+ system deps) into $pw_cache"
fi

if [ "$CHECK" = 0 ]; then
  step "Oneshot .env (npm run setup --from-env)"
  as_svc npm run --silent setup -- --from-env --env-file "$ENV_FILE"

  step "Seed ($SEED)"
  as_svc node scripts/provision-seed.cjs --env-file "$ENV_FILE"
elif [ -f "$ONESHOT_DIR/scripts/provision-seed.cjs" ] && have node && [ -r "$ENV_FILE" ]; then
  step "Seed ($SEED)"
  if [ "$(id -u)" = 0 ] && id "$SVC_USER" >/dev/null 2>&1; then
    as_svc node scripts/provision-seed.cjs --env-file "$ENV_FILE" --check || MISSING=$((MISSING + 1))
  else
    (cd "$ONESHOT_DIR" && node scripts/provision-seed.cjs --env-file "$ENV_FILE" --check) || MISSING=$((MISSING + 1))
  fi
fi

step "Per-run database baseline ($DB_BASELINE)"
if [ "$PER_RUN_DB" != 1 ]; then ok "ONESHOT_PER_RUN_DB is not 1 — runs share $DB_NAME"
elif [ ! -f "$ONESHOT_DIR/scripts/app.cjs" ] || ! have node; then due "cannot build the baseline yet (no app.cjs or node)"
else
  has_baseline=""
  if have psql; then
    has_baseline="$(PGPASSWORD="$DB_PASSWORD" psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d postgres -XAtqw \
      -c "SELECT 1 FROM pg_database WHERE datname = '$DB_BASELINE'" 2>/dev/null || true)"
  fi
  if [ "$has_baseline" = 1 ] && [ "$REFRESH_BASELINE" = 0 ]; then ok "$DB_BASELINE exists (--refresh-baseline rebuilds it from $DB_NAME)"
  elif [ "$CHECK" = 1 ]; then due "$DB_BASELINE missing — per-run databases stay off until it exists"
  else
    as_svc node scripts/app.cjs baseline --refresh --terminate
    did "built $DB_BASELINE from $DB_NAME (node scripts/app.cjs baseline --refresh --terminate)"
  fi
fi

# ------------------------------------------------------------ oneshot board

# The telemetry board, self-hosted: the same Next.js app that ran on Vercel, on this
# server's Postgres instead of Supabase. Its database starts empty, so it records from
# the day it is installed. The board talks to Postgres with plain `pg` and skips TLS for
# 127.0.0.1, so nothing in it changes; only where DATABASE_URL points does. The collector
# writes to that same database directly, so the board's port has no telemetry write path
# and there is no ingest token: Postgres stays on loopback, and the board's logins guard :3100.
board_restart=0
if [ "$BOARD" = 1 ]; then
  step "Oneshot Board ($BOARD_DIR, port $BOARD_PORT, database $BOARD_DB)"
  [[ "$BOARD_PORT" =~ ^[0-9]+$ ]] || die "BOARD_PORT '$BOARD_PORT' is not a port number" "fix it in $ENV_FILE"
  if is_placeholder "${CFG[BOARD_SESSION_SECRET]:-}"; then
    if [ "$CHECK" = 1 ]; then due "BOARD_SESSION_SECRET unset in $ENV_FILE (ONESHOT_BOARD=1)"
    else die "BOARD_SESSION_SECRET unset in $ENV_FILE (ONESHOT_BOARD=1)" "openssl rand -hex 32, into $ENV_FILE"; fi
  fi

  # As the checkout's owner: git refuses a repo owned by another user (safe.directory), so
  # root's own `git -C` would read nothing here.
  board_git() {
    if [ "$(id -u)" = 0 ]; then runuser -u "$SVC_USER" -- env HOME="$SVC_HOME" git -C "$BOARD_DIR" "$@"
    else git -C "$BOARD_DIR" "$@"; fi
  }
  if [ -f "$BOARD_DIR/web/package.json" ]; then
    board_branch="$(board_git rev-parse --abbrev-ref HEAD 2>/dev/null || echo '?')"
    if [ "$board_branch" = "$BOARD_REF" ]; then ok "$BOARD_DIR on $BOARD_REF ($(board_git rev-parse --short HEAD 2>/dev/null || echo '?'))"
    elif [ "$board_branch" = '?' ] && [ "$(id -u)" != 0 ]; then warn "not root: board checkout branch not inspected"
    elif [ "$CHECK" = 1 ]; then due "$BOARD_DIR is on $board_branch, BOARD_REF=$BOARD_REF — git -C $BOARD_DIR checkout $BOARD_REF"
    else
      { board_git fetch -q origin "$BOARD_REF" && board_git checkout -q "$BOARD_REF"; } \
        || die "could not switch $BOARD_DIR from $board_branch to $BOARD_REF" "local changes? sudo -u $SVC_USER -H git -C $BOARD_DIR status"
      did "switched $BOARD_DIR from $board_branch to $BOARD_REF ($(board_git rev-parse --short HEAD))"
    fi
  elif [ "$CHECK" = 1 ]; then due "$BOARD_DIR is not a checkout of $BOARD_REPO"
  else
    install -d -m 0755 -o "$SVC_USER" -g "$SVC_USER" "$BOARD_DIR"
    runuser -u "$SVC_USER" -- env HOME="$SVC_HOME" git clone -q --branch "$BOARD_REF" "$BOARD_REPO" "$BOARD_DIR" \
      || die "could not clone $BOARD_REPO at $BOARD_REF" "private repo? clone it as $SVC_USER with credentials: sudo -u $SVC_USER -H git clone --branch $BOARD_REF <url> $BOARD_DIR, then re-run"
    did "cloned $BOARD_REPO at $BOARD_REF"
  fi

  # Screenshots and videos the collector copies in and the board serves at /media/.
  # After the clone: git will not clone into a directory that already has files.
  if [ -d "$BOARD_MEDIA_DIR" ]; then ok "media dir $BOARD_MEDIA_DIR"
  elif [ "$CHECK" = 1 ]; then due "media dir $BOARD_MEDIA_DIR missing"
  else install -d -m 0750 -o "$SVC_USER" -g "$SVC_USER" "$BOARD_MEDIA_DIR"; did "created $BOARD_MEDIA_DIR (mode 750)"
  fi

  if [ "$CHECK" = 1 ] && [ "$(id -u)" != 0 ]; then warn "not root: board database not inspected"
  elif pg -c 'SELECT 1' >/dev/null 2>&1; then
    if [ "$(pg -c "SELECT 1 FROM pg_database WHERE datname = '$BOARD_DB'")" = 1 ]; then ok "database $BOARD_DB"
    elif [ "$CHECK" = 1 ]; then due "database $BOARD_DB missing"
    else pg -c "CREATE DATABASE $BOARD_DB OWNER $DB_USER" >/dev/null && did "created database $BOARD_DB (empty: the board records from now on)"
    fi
    # With no ingest token, loopback-only Postgres is what keeps the board's data off the LAN.
    listen="$(pg -c 'show listen_addresses' 2>/dev/null || echo '?')"
    off_box=0
    IFS=',' read -ra listen_addrs <<<"$listen"
    for a in "${listen_addrs[@]}"; do
      case "${a// /}" in localhost|127.0.0.1|::1) ;; *) off_box=1 ;; esac
    done
    if [ "$off_box" = 0 ]; then ok "Postgres listens on loopback only ($listen)"
    else warn "Postgres listens on $listen — the board database is reachable off-box; set listen_addresses = 'localhost' in postgresql.conf"
    fi
  else due "Postgres not answering — board database not checked"
  fi

  # Written here rather than kept in the main env file: DATABASE_URL is composed from
  # DB_USER/DB_PASSWORD, and the board expects SESSION_SECRET by that name. The collector
  # reads the same URL as BOARD_DATABASE_URL from here, never from oneshot.env: the
  # conductor starts a collector of its own when it sees that key, and this one has a unit.
  if have node; then
    # Every character outside [A-Za-z0-9._~-] percent-encoded, so the line reads the same
    # to systemd's EnvironmentFile and to a shell sourcing it for npm run user:add.
    urlenc() { node -p 'encodeURIComponent(process.argv[1]).replace(/[!\x27()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase())' "$1"; }
    db_url="postgresql://$(urlenc "$DB_USER"):$(urlenc "$DB_PASSWORD")@127.0.0.1:$DB_PORT/$BOARD_DB"
    # The board links back to the fleet dashboard on this host's first address.
    board_ip="$(hostname -I 2>/dev/null | awk '{print $1}' || true)"
    tmp_env="$(mktemp)"
    cat > "$tmp_env" <<ENV
# Written by scripts/setup-server.sh from $ENV_FILE — edit that file and re-run, not this one.
DATABASE_URL="$db_url"
SESSION_SECRET=$(cfg BOARD_SESSION_SECRET)
RETENTION_DAYS=$(cfg BOARD_RETENTION_DAYS 90)
PORT=$BOARD_PORT
BOARD_MEDIA_DIR=$BOARD_MEDIA_DIR
FLEET_URL=http://${board_ip:-127.0.0.1}:$(cfg ONESHOT_DASHBOARD_PORT 8787)
BOARD_DATABASE_URL="$db_url"
BOARD_OPERATOR=$(cfg BOARD_OPERATOR "$(cfg ONESHOT_OPERATOR "$(hostname -s)")")
ENV
    if [ -f "$BOARD_ENV" ] && cmp -s "$tmp_env" "$BOARD_ENV"; then ok "$BOARD_ENV current"
    elif [ "$CHECK" = 1 ]; then due "$BOARD_ENV missing or out of date"
    else install -m 0600 -o "$SVC_USER" -g "$SVC_USER" "$tmp_env" "$BOARD_ENV"; board_restart=1; did "wrote $BOARD_ENV (mode 600)"
    fi
    rm -f "$tmp_env"
  else due "node missing — $BOARD_ENV not written"
  fi

  as_board() { (cd "$BOARD_DIR/web" && runuser -u "$SVC_USER" -- env HOME="$SVC_HOME" PATH="$PATH" NO_COLOR=1 NEXT_TELEMETRY_DISABLED=1 "$@"); }
  if [ -f "$BOARD_DIR/web/package-lock.json" ]; then
    stamp="$(sha256sum "$BOARD_DIR/web/package-lock.json" | cut -d' ' -f1) $(board_git rev-parse HEAD 2>/dev/null)"
    if [ -f "$BOARD_DIR/web/.next/.oneshot-build" ] && [ "$(cat "$BOARD_DIR/web/.next/.oneshot-build")" = "$stamp" ]; then
      ok "board built at $(board_git rev-parse --short HEAD)"
    elif [ "$CHECK" = 1 ]; then due "board not built for $(board_git rev-parse --short HEAD 2>/dev/null)"
    else
      chown -R "$SVC_USER:$SVC_USER" "$BOARD_DIR"
      as_board npm ci --no-audit --no-fund >/dev/null
      as_board npm run build >/dev/null || die "the board's next build failed" "cd $BOARD_DIR/web && sudo -u $SVC_USER npm run build"
      printf '%s' "$stamp" | as_board tee .next/.oneshot-build >/dev/null
      board_restart=1
      did "npm ci + next build"
    fi
  fi

  if [ "$CHECK" = 0 ] && [ -f "$BOARD_ENV" ] && [ -d "$BOARD_DIR/web/node_modules/pg" ]; then
    # Idempotent (CREATE ... IF NOT EXISTS throughout), so it runs on every pass and
    # picks up whatever the board's schema.sql has gained since.
    db_url="$(sed -n 's/^DATABASE_URL="\(.*\)"$/\1/p' "$BOARD_ENV")"
    as_board env DATABASE_URL="$db_url" node scripts/db-migrate.mjs >/dev/null \
      || die "applying $BOARD_DIR/db/schema.sql to $BOARD_DB failed" "cd $BOARD_DIR/web && sudo -u $SVC_USER env DATABASE_URL=… npm run db:migrate"
    ok "schema applied to $BOARD_DB"
    users="$(pg -d "$BOARD_DB" -c 'SELECT count(*) FROM users' 2>/dev/null || echo 0)"
    if [ "$users" = 0 ]; then
      warn "the board has no login yet — add one (prompts for the password):"
      warn "  sudo -u $SVC_USER -H bash -c 'cd $BOARD_DIR/web && set -a && . $BOARD_ENV && npm run user:add -- <username>'"
    else ok "$users board login(s)"
    fi
  fi

  if have ufw && ufw_status="$(ufw status 2>/dev/null)" && grep -q '^Status: active' <<<"$ufw_status"; then
    if grep -Eq "^$BOARD_PORT(/tcp)?[[:space:]]" <<<"$ufw_status"; then ok "ufw allows $BOARD_PORT/tcp"
    else warn "open the board port: ufw allow $BOARD_PORT/tcp"
    fi
  fi
fi

# ----------------------------------------------------------------- systemd

step "systemd units"
UNITS=(oneshot-conductor.service oneshot-dashboard.service oneshot-window.service oneshot-window.timer)
ENABLE=(oneshot-conductor.service oneshot-dashboard.service oneshot-window.timer)
if [ "$BOARD" = 1 ]; then
  UNITS+=(oneshot-board.service oneshot-board-collector.service)
  ENABLE+=(oneshot-board.service oneshot-board-collector.service)
fi
if ! have systemctl || [ ! -d /run/systemd/system ]; then
  warn "systemd is not running here (container?) — units not installed"
else
  changed=0
  for u in "${UNITS[@]}"; do
    src="$ONESHOT_DIR/deploy/systemd/$u"; dst="/etc/systemd/system/$u"
    [ -f "$src" ] || src="$SELF_ROOT/deploy/systemd/$u"
    if [ -f "$dst" ] && cmp -s "$src" "$dst"; then ok "$u current"
    elif [ "$CHECK" = 1 ]; then due "$u not installed or out of date"
    else install -m 0644 "$src" "$dst"; changed=1; did "installed $dst"
    fi
  done
  if [ "$CHECK" = 0 ]; then
    [ "$changed" = 1 ] && systemctl daemon-reload
    systemctl enable "${ENABLE[@]}" >/dev/null 2>&1 && ok "enabled ${ENABLE[*]}"
    if [ "$START" = 1 ]; then systemctl restart "${ENABLE[@]}" && did "(re)started ${ENABLE[*]} (the conductor only inside ONESHOT_WINDOW)"
    else
      ok "not started (pass --start, or: sudo systemctl start ${ENABLE[*]})"
      # A new build or board.env is not live until the board restarts; only if it is running.
      if [ "$board_restart" = 1 ] && systemctl is-active --quiet oneshot-board.service; then
        systemctl restart oneshot-board.service oneshot-board-collector.service && did "restarted the board for its new build/env"
      fi
    fi
  else
    for u in "${ENABLE[@]}"; do
      if systemctl is-enabled --quiet "$u" 2>/dev/null; then ok "$u enabled"; else due "$u not enabled"; fi
    done
  fi
fi

# --------------------------------------------------------- final verdict

step "Prerequisite check (src/lib/appenv.cjs)"
if ! have node || [ "$(node_major)" -lt 21 ]; then
  due "node is missing or too old to run the check"
elif [ ! -f "$ONESHOT_DIR/src/lib/appenv.cjs" ]; then
  due "$ONESHOT_DIR/src/lib/appenv.cjs missing"
else
  envarg=(); [ -r "$ENV_FILE" ] && envarg=(--env-file "$ENV_FILE")
  if [ "$(id -u)" = 0 ] && id "$SVC_USER" >/dev/null 2>&1; then
    as_svc node src/lib/appenv.cjs "${envarg[@]}" || MISSING=$((MISSING + 1))
  else
    (cd "$ONESHOT_DIR" && node src/lib/appenv.cjs "${envarg[@]}") || MISSING=$((MISSING + 1))
  fi
fi

echo
if [ "$MISSING" -gt 0 ]; then
  printf '%s%d item(s) need attention%s — see the due/FAIL lines above.\n' "$R" "$MISSING" "$X"
  exit 1
fi
printf '%sServer ready.%s ' "$G" "$X"
[ "$CHECK" = 1 ] && echo "(check only)" || echo "Logs: journalctl -u oneshot-conductor -f"
