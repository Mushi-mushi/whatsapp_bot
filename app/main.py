# app/main.py

import os
import sys
import threading
from bot import run_bot
from server import run_server

LOG_FILE_PATH = 'logs/bot.log'
LOG_MAX_BYTES = 5 * 1024 * 1024  # Rotate at startup when the log exceeds ~5 MB.


class _Tee:
    """Writes to the original stream and a persistent on-disk log file."""

    def __init__(self, stream, log_file):
        self._stream = stream
        self._log_file = log_file

    def write(self, data):
        self._stream.write(data)
        try:
            self._log_file.write(data)
            self._log_file.flush()
        except Exception:
            pass

    def flush(self):
        try:
            self._stream.flush()
        finally:
            try:
                self._log_file.flush()
            except Exception:
                pass


def _setup_disk_logging():
    """Tees stdout/stderr to logs/bot.log so output persists on disk for diagnosis."""
    try:
        os.makedirs(os.path.dirname(LOG_FILE_PATH) or ".", exist_ok=True)
        if os.path.exists(LOG_FILE_PATH) and os.path.getsize(LOG_FILE_PATH) > LOG_MAX_BYTES:
            os.replace(LOG_FILE_PATH, LOG_FILE_PATH + ".1")
        log_file = open(LOG_FILE_PATH, "a", buffering=1, encoding="utf-8")
        sys.stdout = _Tee(sys.stdout, log_file)
        sys.stderr = _Tee(sys.stderr, log_file)
    except Exception as e:
        print(f"[WARNING] Could not set up on-disk logging: {e}")


if __name__ == '__main__':
    _setup_disk_logging()
    print("Starting services...")

    # Run the bot in a separate, non-daemon thread
    bot_thread = threading.Thread(target=run_bot)
    # The line "bot_thread.daemon = True" has been REMOVED.
    bot_thread.start()

    # The main thread will now run the server.
    # The program will not exit until BOTH the server AND the bot_thread have finished.
    # Since they run in infinite loops, the container will stay alive.
    run_server()