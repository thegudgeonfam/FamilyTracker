#!/bin/bash
# Stable I/O helper for the childcare-email-sync scheduled task.
#
# Purpose: give the scheduled task ONE unchanging command to read and write the
# tracker through the single-writer server, so its tool-permission approval sticks
# across runs (the task's own per-run scratchpad paths change every run and would
# otherwise re-prompt each time).
#
# Usage:
#   bash app/ftsync.sh get        # GET tracker JSON -> /tmp/ftsync/data.json, prints "HTTP <code>"
#   bash app/ftsync.sh put        # PUT /tmp/ftsync/data.json back to the server, prints "HTTP <code>"
#
# Workflow for the task: `get`, then mutate /tmp/ftsync/data.json in place with python3,
# then `put`. A non-200 code means the server is unreachable/rejected the write — stop and report.

set -euo pipefail

STATE_DIR="${TMPDIR:-/tmp}/ftsync"   # per-user on macOS, so either account can run this
DATA="$STATE_DIR/data.json"
URL="http://127.0.0.1:4173/api/data"
mkdir -p "$STATE_DIR"

case "${1:-}" in
  get)
    code=$(curl -s -o "$DATA" -w '%{http_code}' --max-time 10 "$URL")
    echo "HTTP $code -> $DATA"
    [ "$code" = "200" ] || exit 1
    ;;
  put)
    [ -f "$DATA" ] || { echo "no $DATA to PUT (run 'get' first)" >&2; exit 2; }
    code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 \
      -X PUT "$URL" -H 'Content-Type: application/json' --data-binary @"$DATA")
    echo "HTTP $code"
    if [ "$code" = "409" ]; then
      echo "revision conflict: tracker changed since 'get' — re-run get and re-apply your changes" >&2
      exit 3
    fi
    [ "$code" = "200" ] || exit 1
    ;;
  *)
    echo "usage: ftsync.sh get|put" >&2
    exit 2
    ;;
esac
