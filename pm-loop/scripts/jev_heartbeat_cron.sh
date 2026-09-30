#!/bin/zsh
# Jev eval heartbeat — daily. Scores Jev in batches of 50 finished tickets; posts to Slack when a batch completes.
# Until .claude/erp-facts.json is merged to erp dev, it reads the reviewed draft on the zones branch.
set -uo pipefail
LOG="$HOME/.claude/logs/jev_heartbeat.log"
ERP="$HOME/Documents/ai/claude/Workstream/erp"
mkdir -p "$(dirname "$LOG")"
if ! git -C "$ERP" cat-file -e origin/dev:.claude/erp-facts.json 2>/dev/null; then
  export PM_LOOP_MAP_DIR="$HOME/Documents/ai/claude/Workstream/erp-zones/.claude"
fi
{ echo "== $(date '+%F %T') map=${PM_LOOP_MAP_DIR:-origin/dev}"; python3 "$HOME/.claude/scripts/jev_heartbeat.py"; } >>"$LOG" 2>&1 \
  || python3 "$HOME/.claude/scripts/slack_post.py" --text "Jev heartbeat FAILED — see $LOG" >/dev/null 2>&1
