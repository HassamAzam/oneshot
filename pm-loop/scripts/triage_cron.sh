#!/bin/zsh
# Plane triage loop (Loop A) — scheduled runner.
#
# Judgement lives in the ticket-triage skill, so this drives a headless
# Claude session rather than calling the CLI directly. The CLI subcommands
# the skill invokes are what actually touch Plane.
#
# LIVE: decisions and routes are written to Plane. To trial a change without
# writing, run by hand with TRIAGE_DRY_RUN=1 exported.

set -uo pipefail

TRIAGE_ROOT="$HOME/Documents/ai/claude/Workstream/triage-cron"
LOG="$HOME/.claude/logs/triage.log"

export PLANE_API_KEY="$(python3 "$HOME/.claude/scripts/pm_secrets.py" get PLANE_API_KEY)"
export TRIAGE_SENTINEL_ISSUE_ID="bdb555f7-e4d5-4e10-92aa-0987a810f094"
# Read-only use: the misroute report looks up where groomed tickets ended up.
export GITLAB_TOKEN="$(python3 "$HOME/.claude/scripts/pm_secrets.py" get GITLAB_TOKEN)"

# TRIAGE_SLACK_WEBHOOK is intentionally unset. The digest prints to this
# log, which is the authoritative record; Slack is optional decoration.

mkdir -p "$(dirname "$LOG")"
cd "$TRIAGE_ROOT" || { echo "$(date '+%F %T') FATAL: $TRIAGE_ROOT missing" >>"$LOG"; exit 1; }

{
  echo ""
  echo "==================== $(date '+%F %T %Z') ===================="
  echo "branch: $(git rev-parse --abbrev-ref HEAD) @ $(git rev-parse --short HEAD)"
  echo "dry_run: ${TRIAGE_DRY_RUN:-0}"
  echo "-------------------------------------------------------------"
} >>"$LOG"

# The prompt goes over stdin: --add-dir and friends are variadic and will
# otherwise swallow a trailing prompt argument.
echo "/ticket-triage" | "$HOME/.local/bin/claude" \
  --print \
  --permission-mode acceptEdits >>"$LOG" 2>&1

STATUS=$?
echo "--- run finished, exit=$STATUS ---" >>"$LOG"
exit $STATUS
