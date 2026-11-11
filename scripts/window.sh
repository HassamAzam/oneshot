#!/usr/bin/env bash
# Keeps the conductor inside its daily run window. ONESHOT_WINDOW is "<from>-<to>" where each
# end is an hour (1-0) or a clock time (01:10-00:50), or "always". A <from> later than <to>
# wraps past midnight. The default 01:10-00:50 stops the conductor ten minutes before the
# server's 01:00 reboot and starts it ten minutes after, so a run reaches a checkpoint first.
#   window.sh check   exit 0 inside the window, 1 outside (the conductor's ExecCondition)
#   window.sh apply   start the conductor inside the window, stop it outside (the timer)
set -euo pipefail

WINDOW="${ONESHOT_WINDOW:-01:10-00:50}"
UNIT=oneshot-conductor.service

minutes() {
  [[ "$1" =~ ^([0-9]{1,2})(:([0-9]{2}))?$ ]] || return 1
  local h=$((10#${BASH_REMATCH[1]})) m=$((10#${BASH_REMATCH[3]:-0}))
  [ "$m" -le 59 ] && [ $((h * 60 + m)) -le 1440 ] || return 1
  echo $((h * 60 + m))
}

in_window() {
  [ "$WINDOW" = always ] && return 0
  local bad="ONESHOT_WINDOW='$WINDOW' is not <from>-<to> (hours or HH:MM) or always"
  [[ "$WINDOW" =~ ^([0-9:]+)-([0-9:]+)$ ]] || { echo "$bad" >&2; exit 2; }
  local a="${BASH_REMATCH[1]}" b="${BASH_REMATCH[2]}" from to now
  from=$(minutes "$a") && to=$(minutes "$b") || { echo "$bad" >&2; exit 2; }
  now=$((10#$(date +%H) * 60 + 10#$(date +%M)))
  if [ "$from" -le "$to" ]; then [ "$now" -ge "$from" ] && [ "$now" -lt "$to" ]
  else [ "$now" -ge "$from" ] || [ "$now" -lt "$to" ]; fi
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
