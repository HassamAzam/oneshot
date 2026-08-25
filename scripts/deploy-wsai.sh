#!/usr/bin/env bash
#
# WSAI deployment — Oneshot's vendored copy.
#
# Adapted from Hassam's ~/Documents/"WSAI deployment script.sh". His original
# is left untouched for manual use; this copy exists because the original is
# not driveable headlessly:
#
#   1. It blocks on `read -r -p "press Enter to continue"` when the branch is
#      already up to date. Under `set -euo pipefail` you cannot simply feed it
#      /dev/null — `read` returns 1 at EOF and aborts the script. --yes skips
#      the prompt entirely.
#   2. It printed the deployed commit only for human eyes. This copy also emits
#      machine-readable ONESHOT_* lines that phase 10 parses to confirm the box
#      actually moved to the SHA this run produced.
#
#   ./deploy-wsai.sh --yes                  # deploy wsai dev
#   ./deploy-wsai.sh --yes stage
#   ./deploy-wsai.sh --yes dev --npm --pip
#
# Use --npm / --pip only when the branch actually changed package.json or
# requirements/ — Oneshot decides this from its own diff and passes the flags.

set -euo pipefail

SERVER="${ONESHOT_DEPLOY_SERVER:-ibrahim@172.30.1.64}"
REMOTE="wsai"
APP_DIR="/home/erp_user/demo/erp_app"
BUILD_DIR="/home/erp_user/demo"
BUILD_SCRIPT="./erp_demo_full_build.sh"
DEPLOY_KEY="/home/erp_user/.ssh/github/wsai"
SITE_HOST="ws-ai-demo.arbisoft.com"

POLL_SECONDS=15
TIMEOUT_MINUTES=45
STABILITY_SECONDS=90

BRANCH="dev"
INSTALL_FRONTEND="false"
INSTALL_BACKEND="false"
ASSUME_YES="false"

for arg in "$@"; do
    case "$arg" in
        --npm)  INSTALL_FRONTEND="true" ;;
        --pip)  INSTALL_BACKEND="true" ;;
        --yes|-y) ASSUME_YES="true" ;;
        --*)    echo "Unknown option: $arg" >&2; exit 2 ;;
        *)      BRANCH="$arg" ;;
    esac
done

LOG="/tmp/deploy_${REMOTE}_${BRANCH}_$(date +%Y%m%d-%H%M%S).log"

say() { printf '\n\033[1m%s\033[0m\n' "$*"; }
emit() { printf 'ONESHOT_%s=%s\n' "$1" "$2"; }

remote() { ssh -n -o BatchMode=yes -o ConnectTimeout=20 "$SERVER" "$@"; }

# ---------------------------------------------------------------------------
# 1. Connectivity
# ---------------------------------------------------------------------------
say "Connecting to $SERVER ..."
if ! remote 'echo ok' >/dev/null 2>&1; then
    echo "Cannot reach $SERVER."
    echo "That subnet is VPN-gated — check the VPN is connected, then retry."
    emit RESULT unreachable
    exit 1
fi
echo "Connected."
emit BRANCH "$BRANCH"

# ---------------------------------------------------------------------------
# 2. What are we about to deploy?
# ---------------------------------------------------------------------------
say "Fetching ${REMOTE}/${BRANCH} ..."
remote "cd $APP_DIR && sudo -u erp_user ssh-agent bash -c '
    ssh-add $DEPLOY_KEY >/dev/null 2>&1
    git fetch $REMOTE $BRANCH 2>&1 | tail -2
'"

BEFORE_SHA=$(remote "cd $APP_DIR && sudo -u erp_user git rev-parse HEAD")
TARGET_SHA=$(remote "cd $APP_DIR && sudo -u erp_user git rev-parse $REMOTE/$BRANCH")
emit BEFORE_SHA "$BEFORE_SHA"
emit TARGET_SHA "$TARGET_SHA"

echo
echo "Currently deployed : $(remote "cd $APP_DIR && sudo -u erp_user git log -1 --format='%h %s'")"
echo "Target             : $(remote "cd $APP_DIR && sudo -u erp_user git log -1 --format='%h %s' $REMOTE/$BRANCH")"

NEW_COMMITS=$(remote "cd $APP_DIR && sudo -u erp_user git log --oneline HEAD..$REMOTE/$BRANCH" || true)
if [ -z "$NEW_COMMITS" ]; then
    echo
    echo "Already up to date — nothing new to deploy."
    if [ "$ASSUME_YES" = "true" ]; then
        # Re-running still rebuilds and restarts services, which is exactly what
        # we want when a previous deploy half-failed. Idempotent by design.
        echo "--yes: rebuilding and restarting anyway."
        emit ALREADY_CURRENT 1
    else
        echo "Re-running anyway would rebuild and restart services. Ctrl-C to abort,"
        read -r -p "or press Enter to continue: " _
    fi
else
    echo
    echo "New commits:"
    echo "$NEW_COMMITS" | sed 's/^/  /'
fi

DEPS=$(remote "cd $APP_DIR && sudo -u erp_user git diff --name-only HEAD $REMOTE/$BRANCH -- package.json requirements/" || true)
MIGRATIONS=$(remote "cd $APP_DIR && sudo -u erp_user git diff --name-only HEAD $REMOTE/$BRANCH | grep migrations" || true)

echo
if [ -n "$DEPS" ]; then
    echo "!! Dependency files changed:"
    echo "$DEPS" | sed 's/^/     /'
    emit DEPS_CHANGED 1
    if [ "$INSTALL_FRONTEND" = "false" ] && [ "$INSTALL_BACKEND" = "false" ]; then
        echo "   WARNING: deploying without --npm/--pip despite dependency changes."
    fi
else
    echo "Dependencies : unchanged"
    emit DEPS_CHANGED 0
fi
if [ -n "$MIGRATIONS" ]; then
    echo "Migrations   : NEW"; echo "$MIGRATIONS" | sed 's/^/     /'; emit MIGRATIONS 1
else
    echo "Migrations   : none"; emit MIGRATIONS 0
fi

# ---------------------------------------------------------------------------
# 3. Launch, detached so a dropped SSH cannot kill the build
# ---------------------------------------------------------------------------
say "Deploying $REMOTE/$BRANCH  (frontend_packages=$INSTALL_FRONTEND backend_packages=$INSTALL_BACKEND)"
echo "Log on server: $LOG"
emit LOG "$LOG"

remote "cd $BUILD_DIR && setsid nohup $BUILD_SCRIPT $BRANCH $INSTALL_FRONTEND $INSTALL_BACKEND $REMOTE \
        > $LOG 2>&1 < /dev/null & disown" || true

# ---------------------------------------------------------------------------
# 4. Follow it
#
# The build is silent for long stretches (webpack, collectstatic). Silence is
# normal. A genuine stall looks like: process in D state, zero CPU growth, and
# /sys/block/sda/inflight pinned at a non-zero value that never moves — a lost
# I/O request at the hypervisor, cleared by `sudo kill -9 <pid>`.
# ---------------------------------------------------------------------------
say "Building — this is silent for several minutes at a time."
echo

deadline=$(( $(date +%s) + TIMEOUT_MINUTES * 60 ))
shown=0
while :; do
    if [ "$(date +%s)" -gt "$deadline" ]; then
        echo
        echo "Timed out after ${TIMEOUT_MINUTES}m. The build may still be running."
        echo "Check:  ssh $SERVER 'tail -20 $LOG'"
        emit RESULT timeout
        exit 1
    fi

    total=$(remote "wc -l < $LOG" 2>/dev/null || echo 0)
    if [ "$total" -gt "$shown" ]; then
        remote "tail -n +$((shown + 1)) $LOG" 2>/dev/null | sed 's/^/  | /' || true
        shown=$total
    fi

    if remote "grep -q 'Build complete.' $LOG" 2>/dev/null; then
        break
    fi
    sleep "$POLL_SECONDS"
done

# ---------------------------------------------------------------------------
# 5. Verify — the build script has no `set -e`, so it restarts services and
#    prints "Build complete." even if migrate failed. Never trust that line.
# ---------------------------------------------------------------------------
say "Verifying"

echo "Migrations:"
remote "grep -iE 'Applying|No migrations' $LOG | tail -3" | sed 's/^/  /' || true

AFTER_SHA=$(remote "cd $APP_DIR && sudo -u erp_user git rev-parse HEAD")
emit AFTER_SHA "$AFTER_SHA"

echo
echo "Branch:"
remote "cd $APP_DIR && sudo -u erp_user git log -1 --format='  %h %s'"

DRIFT=$(remote "cd $APP_DIR && sudo -u erp_user git diff --stat $REMOTE/$BRANCH HEAD" || true)
if [ -z "$DRIFT" ]; then
    echo "  matches $REMOTE/$BRANCH exactly"
    emit DRIFT 0
else
    echo "  !! HEAD does NOT match $REMOTE/$BRANCH:"
    echo "$DRIFT" | sed 's/^/     /'
    emit DRIFT 1
fi

echo
echo "Services:"
remote "sudo supervisorctl status | grep demo_erp" | sed 's/^/  /' || true

echo
CODE=$(remote "curl -sk -o /dev/null -w '%{http_code}' -H 'Host: $SITE_HOST' https://127.0.0.1/" || echo "000")
echo "Site: HTTP $CODE   (curl by IP without the Host header returns 400 — ALLOWED_HOSTS)"
emit HTTP "$CODE"

echo
echo "Errors in app logs:"
ERRORS=$(remote "sudo tail -40 /home/erp_user/demo/logs/*.log 2>/dev/null | grep -iE 'traceback|critical' | tail -5" || true)
if [ -z "$ERRORS" ]; then echo "  none"; emit APP_ERRORS 0; else echo "$ERRORS" | sed 's/^/  /'; emit APP_ERRORS 1; fi

# Services are seconds old above; a crash-loop would still read RUNNING.
say "Confirming services are stable (${STABILITY_SECONDS}s) ..."
sleep "$STABILITY_SECONDS"
remote "sudo supervisorctl status | grep demo_erp" | sed 's/^/  /' || true
echo
echo "Same PIDs with ~2min uptime above means no crash-loop."

case "$CODE" in
    200) say "Done — $REMOTE/$BRANCH deployed."; emit RESULT ok; exit 0 ;;
    *)   say "Finished, but the site returned HTTP $CODE."; emit RESULT http_$CODE; exit 1 ;;
esac
