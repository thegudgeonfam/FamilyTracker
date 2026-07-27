"""Local family-ops tracker server.

Owns family-ops-backup.json directly: serves it to the browser UI, writes
edits back to disk, auto-commits changes to git, and periodically reconciles
with GitHub so there's no manual export/backup/commit step left to do by hand.

Single-writer model: every change — from the browser UI or from the email-sync
routine — comes through this server's /api/data endpoint. Nothing else edits the
file or runs git, which is what keeps the two macOS accounts from colliding.
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
_git_lock = threading.Lock()
_commit_timer = None
_commit_timer_lock = threading.Lock()


def run_git(*args):
    return subprocess.run(
        ["git", *args], cwd=REPO_DIR, capture_output=True, text=True
    )


def commit_data_file():
    with _git_lock:
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


def sync_and_push():
    """Reconcile with origin, then push.

    Fetches first so we know origin's real state (the old code compared against a
    stale remote-tracking ref and would wedge silently on any divergence). If
    origin moved ahead, replay our local commits on top of it. On a genuine
    conflict we abort and leave everything intact rather than risk clobbering
    the family's data — a human can sort it out. All git work is serialized
    behind _git_lock so a debounced commit can't race the rebase.
    """
    with _git_lock:
        # Nothing to reconcile if we can't reach origin (offline / auth failure).
        if run_git("fetch", "origin").returncode != 0:
            return

        behind = run_git("rev-list", "--count", "HEAD..origin/main")
        if behind.returncode == 0 and behind.stdout.strip() not in ("", "0"):
            if run_git("rebase", "origin/main").returncode != 0:
                run_git("rebase", "--abort")
                return  # real conflict — don't lose data; wait for a human

        ahead = run_git("rev-list", "--count", "origin/main..HEAD")
        if ahead.returncode == 0 and ahead.stdout.strip() not in ("", "0"):
            run_git("push", "origin", "main")


def push_loop():
    while True:
        time.sleep(PUSH_INTERVAL_SECONDS)
        try:
            sync_and_push()
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
        sync_and_push()


if __name__ == "__main__":
    main()
