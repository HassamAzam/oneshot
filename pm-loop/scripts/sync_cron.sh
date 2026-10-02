#!/bin/zsh
# Plane <-> GitLab sync (Loop B) — scheduled runner.
#
# Deterministic sync with no LLM in the path, so this calls the CLI directly
# rather than driving a headless Claude session the way Loop A's runner does.
#
# SHADOW MODE: while SYNC_DRY_RUN=1 is set below, no write reaches Plane or
# GitLab. The run still reads both APIs, makes every decision, and logs the
# full digest — it just does not act. Remove that one line to go live, and
# only after reading the log and agreeing with what it proposes.

set -uo pipefail

SYNC_ROOT="$HOME/Documents/ai/claude/Workstream/triage-cron"
LOG="$HOME/.claude/logs/sync.log"

export PLANE_API_KEY="$(python3 "$HOME/.claude/scripts/pm_secrets.py" get PLANE_API_KEY)"
export GITLAB_TOKEN="$(python3 "$HOME/.claude/scripts/pm_secrets.py" get GITLAB_TOKEN)"

# ---- shadow mode gate: delete this line to let the loop write ----
export SYNC_DRY_RUN=1
# ------------------------------------------------------------------

mkdir -p "$(dirname "$LOG")"
cd "$SYNC_ROOT" || { echo "$(date '+%F %T') FATAL: $SYNC_ROOT missing" >>"$LOG"; exit 1; }

{
  echo ""
  echo "==================== $(date '+%F %T %Z') ===================="
  echo "branch: $(git rev-parse --abbrev-ref HEAD) @ $(git rev-parse --short HEAD)"
  echo "dry_run: ${SYNC_DRY_RUN:-0}"
  echo "-------------------------------------------------------------"
} >>"$LOG"

# Both hosts are unreliable — Plane has been measured at roughly one request
# in four failing, and GitLab drops out with the VPN. The client already
# retries individual requests; this retries the run itself, because a whole
# run lost to one unlucky call is a wasted hour on an hourly schedule.
STATUS=1
for attempt in 1 2 3; do
  if python3 -m scripts.sync.cli run >>"$LOG" 2>&1; then
    STATUS=0
    break
  fi
  echo "--- attempt $attempt failed, retrying ---" >>"$LOG"
  sleep 30
done

# Release yellow-zone changes whose characterization tests have merged: the
# sweep adds `Loop` so Oneshot picks them up. Same shadow gate as the sync.
SWEEP_FLAGS=()
[[ "${SYNC_DRY_RUN:-0}" == "1" ]] && SWEEP_FLAGS=(--dry-run)
echo "--- tests-first sweep ${SWEEP_FLAGS[*]} ---" >>"$LOG"
python3 "$HOME/.claude/scripts/groom.py" sweep --notify "${SWEEP_FLAGS[@]}" >>"$LOG" 2>&1 || echo "--- sweep failed (see above; Slack told once); sync status unaffected ---" >>"$LOG"

echo "--- run finished, exit=$STATUS ---" >>"$LOG"
exit $STATUS
