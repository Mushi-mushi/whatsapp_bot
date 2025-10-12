# app/shared_state.py

import datetime

class BotState:
    def __init__(self):
        self.status = "INITIALIZING"  # Other statuses: "NEEDS_LOGIN", "LOGGED_IN", "CRASHED"
        self.qr_code_base64 = None
        self.siesta_until = None
        self.torture_active = False
        self.torture_target_sender = None
        self.torture_messages_to_send = []
        self.torture_start_time = None
        self.torture_last_sent_time = None
        self.torture_message_interval = 1

        # NEW: Insult Game State
        self.insult_game_active = False
        self.insult_game_target_sender = None
        self.insult_game_current_insult_index = None
        self.insult_game_player_wins = 0
        self.insult_game_bot_wins = 0
        self.insult_game_total_rounds = 0
        self.insult_game_last_interaction = None # For timeout
        self.insult_game_used_indices = set() # To prevent repeating insults in a game

# Create a single, shared instance of the state
shared_bot_state = BotState()