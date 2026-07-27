#!/bin/bash
# Double-click this file in Finder to open the Family Tracker dashboard.
# If the server isn't already running, this starts it; either way, it
# opens the dashboard in your default browser.
cd "$(dirname "$0")"

if curl -s -o /dev/null http://127.0.0.1:4173; then
  open http://127.0.0.1:4173
else
  exec app/.venv/bin/python3 app/server.py
fi
