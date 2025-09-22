#!/bin/sh
# entrypoint.sh

# Define the path for the session data inside the user_data volume
SESSION_DIR="/usr/src/app/user_data/session"

# --- THIS IS THE CRITICAL FIX ---
# Find and forcibly remove the SingletonLock file left behind by any crashed Chrome instance.
# This makes the startup process resilient.
echo "[Entrypoint] Cleaning up old session lock files..."
rm -f "$SESSION_DIR/SingletonLock"
# ------------------------------

# Create the session directory if it doesn't exist.
mkdir -p "$SESSION_DIR"

# Change the ownership of the subdirectory to appuser.
chown -R appuser:appuser "$SESSION_DIR"

# Switch from 'root' to 'appuser' and execute the python script.
exec gosu appuser python -u "$@"