#!/bin/sh
set -eu

# Profile path used by Selenium (USER_DATA_DIR = user_data/session in app/bot.py)
SESSION_DIR="/home/appuser/app/user_data/session"

echo "[Entrypoint] Ensuring session directory exists at $SESSION_DIR"
mkdir -p "$SESSION_DIR"

echo "[Entrypoint] Cleaning stale Chromium lock/runtime files"
rm -f "$SESSION_DIR/SingletonLock" \
	"$SESSION_DIR/SingletonSocket" \
	"$SESSION_DIR/SingletonCookie" \
	"$SESSION_DIR/DevToolsActivePort"

# Do not remove cookies/storage databases; those contain the reusable WhatsApp Web session.
exec "$@"