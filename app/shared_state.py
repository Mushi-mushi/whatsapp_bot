# app/shared_state.py

class BotState:
    def __init__(self):
        self.status = "INITIALIZING"  # Other statuses: "NEEDS_LOGIN", "LOGGED_IN", "CRASHED"
        self.qr_code_base64 = None

# Create a single, shared instance of the state
shared_bot_state = BotState()