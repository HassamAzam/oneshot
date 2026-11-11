#!/usr/bin/env bash
# Keeps the conductor inside its daily run window. ONESHOT_WINDOW is "<from>-<to>" in 24h
# hours (default 1-0: runs from 01:00, stops at 00:00 — an hour before the server's nightly
# 01:00 reboot) or "always". A <from> greater than <to> wraps past midnight.
#   window.sh check   exit 0 inside the window, 1 outside (the conductor's ExecCondition)
#   window.sh apply   start the conductor inside the window, stop it outside (the hourly timer)
set -euo pipefail

WINDOW="${ONESHOT_WINDOW:-1-0}"
UNIT=oneshot-conductor.service

in_window() {
  [ "$WINDOW" = always ] && return 0
  [[ "$WINDOW" =~ ^([0-9]{1,2})-([0-9]{1,2})$ ]] || { echo "ONESHOT_WINDOW='$WINDOW' is not <from>-<to> or always" >&2; exit 2; }
  local from=$((10#${BASH_REMATCH[1]})) to=$((10#${BASH_REMATCH[2]})) hour=$((10#$(date +%H)))
  if [ "$from" -le "$to" ]; then [ "$hour" -ge "$from" ] && [ "$hour" -lt "$to" ]
  else [ "$hour" -ge "$from" ] || [ "$hour" -lt "$to" ]; fi
}

case "${1:-apply}" in
  check) in_window ;;
  apply)
    if in_window; then
      systemctl is-active --quiet "$UNIT" || { systemctl start "$UNIT"; echo "window $WINDOW open: started $UNIT"; }
    elif systemctl is-active --quiet "$UNIT"; then
      systemctl stop --no-block "$UNIT"; echo "window $WINDOW closed: stopping $UNIT (runs checkpoint and resume next window)"
    fi ;;
  *) echo "usage: $0 check|apply" >&2; exit 2 ;;
esac
