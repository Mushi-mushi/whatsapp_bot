# app/main.py

import threading
from bot import run_bot
from server import run_server

if __name__ == '__main__':
    print("Starting services...")

    # Run the bot in a separate, non-daemon thread
    bot_thread = threading.Thread(target=run_bot)
    # The line "bot_thread.daemon = True" has been REMOVED.
    bot_thread.start()

    # The main thread will now run the server.
    # The program will not exit until BOTH the server AND the bot_thread have finished.
    # Since they run in infinite loops, the container will stay alive.
    run_server()