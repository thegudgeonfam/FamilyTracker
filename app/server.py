"""Local family-ops tracker server.

Owns family-ops-backup.json directly: serves it to the browser UI, writes
edits back to disk, auto-commits changes to git, and periodically pushes
to GitHub so there's no manual export/backup/commit step left to do by hand.
"""
import json
import os
import subprocess
import threading
import time
import webbrowser
from datetime import datetime, timezone
from pathlib import Path

from flask import Flask, jsonify, request, send_from_directory

APP_DIR = Path(__file__).resolve().parent
REPO_DIR = APP_DIR.parent
DATA_FILE = REPO_DIR / "family-ops-backup.json"
STATIC_DIR = APP_DIR / "static"

PORT = 4173
COMMIT_DEBOUNCE_SECONDS = 2
PUSH_INTERVAL_SECONDS = 20 * 60

app = Flask(__name__, static_folder=None)

_write_lock = threading.Lock()
_commit_timer = None
_commit_timer_lock = threading.Lock()


def run_git(*args):
    return subprocess.run(
        ["git", *args], cwd=REPO_DIR, capture_output=True, text=True
    )


def commit_data_file():
    run_git("add", "family-ops-backup.json")
    staged = run_git("diff", "--cached", "--quiet", "--", "family-ops-backup.json")
    if staged.returncode == 0:
        return
    message = f"Tracker update — {datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M UTC')}"
    run_git("commit", "-m", message)


def schedule_commit():
    global _commit_timer
    with _commit_timer_lock:
        if _commit_timer is not None:
            _commit_timer.cancel()
        _commit_timer = threading.Timer(COMMIT_DEBOUNCE_SECONDS, commit_data_file)
        _commit_timer.daemon = True
        _commit_timer.start()


def push_if_ahead():
    log = run_git("log", "origin/main..HEAD", "--oneline")
    if log.returncode != 0:
        return
    if log.stdout.strip():
        run_git("push", "origin", "main")


def push_loop():
    while True:
        time.sleep(PUSH_INTERVAL_SECONDS)
        try:
            push_if_ahead()
        except Exception:
            pass


@app.route("/")
def index():
    return send_from_directory(STATIC_DIR, "index.html")


@app.route("/<path:filename>")
def static_files(filename):
    return send_from_directory(STATIC_DIR, filename)


@app.route("/api/data", methods=["GET"])
def get_data():
    with _write_lock:
        with open(DATA_FILE, "r", encoding="utf-8") as f:
            return jsonify(json.load(f))


@app.route("/api/data", methods=["PUT"])
def put_data():
    payload = request.get_json(force=True)
    if not isinstance(payload, dict) or "boards" not in payload or "boardOrder" not in payload:
        return jsonify({"error": "payload missing boards/boardOrder"}), 400

    with _write_lock:
        with open(DATA_FILE, "w", encoding="utf-8") as f:
            json.dump(payload, f, indent=2, ensure_ascii=False)
            f.write("\n")

    schedule_commit()
    return jsonify({"ok": True})


def main():
    threading.Thread(target=push_loop, daemon=True).start()
    url = f"http://127.0.0.1:{PORT}"
    if not os.environ.get("FAMILY_TRACKER_HEADLESS"):
        threading.Timer(1.0, lambda: webbrowser.open(url)).start()
    print(f"Family tracker running at {url}")
    try:
        app.run(host="127.0.0.1", port=PORT, debug=False)
    finally:
        commit_data_file()
        push_if_ahead()


if __name__ == "__main__":
    main()
