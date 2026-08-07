#!/bin/bash
# Double-click this file in Finder to open the Family Tracker dashboard.
# If the server isn't already running, this starts it; either way, it
# opens the dashboard in your default browser.
cd "$(dirname "$0")"

if curl -s -o /dev/null http://127.0.0.1:4173; then
  open http://127.0.0.1:4173
else
  # Don't start a per-user copy of the server: it must run as coreygudgeon
  # (it owns the data file and the git repo). Restart the system daemon instead.
  echo "The tracker daemon isn't running. To restart it, run:"
  echo ""
  echo "  sudo launchctl kickstart -k system/com.gudgeonfam.familytracker"
  echo ""
  echo "then double-click this file again."
  read -p "Press Return to close..."
fi
