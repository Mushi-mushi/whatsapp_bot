# app/insults_game.py
print("[DEBUG] insults_game.py is being loaded.") # Add this
import random
import datetime
from shared_state import shared_bot_state # Ensure this import is correct

# --- Insults and their correct comebacks from Monkey Island ---
# (Simplified for direct bot-insults, player-comebacks)
INSULTS_AND_COMEBACKS = [
    {"insult": "You fight like a dairy farmer!", "comeback": "How appropriate. You fight like a cow!"},
    {"insult": "This is the END for you, you gutter-bred pig!", "comeback": "I'm rubber, you're glue..."},
    {"insult": "I will milk every drop of blood from your body!", "comeback": "My tongue is quicker than yours has ever been!"},
    {"insult": "Have you stopped wearing diapers yet?", "comeback": "Why, did you want to borrow one?"},
    {"insult": "I once owned a dog that was smarter than you.", "comeback": "He must have taught you everything you know."},
    {"insult": "No one will ever catch you in your lifetime!", "comeback": "Yeah, and I'm a monkey's uncle."},
    {"insult": "I've heard you were a contemptible sneak!", "comeback": "And I've heard you're going to use that line on everyone!"},
    {"insult": "You are a member of the most common species of rodent!", "comeback": "Do I look like a rat to you?"},
    {"insult": "You make me want to throw up!", "comeback": "You make me want to get married!"},
    {"insult": "I'm going to make you regret the day you were born!", "comeback": "I'm going to make you wish you never met me!"},
    {"insult": "Your mind is a barren wasteland!", "comeback": "My wit is sharper than your dull blade!"},
    {"insult": "My brain has too many convolutions to be impressed by you!", "comeback": "And your face has too many convolutions to be seen in public!"},
    {"insult": "You are a blot on the landscape!", "comeback": "And you are a stain on my intelligence!"},
    {"insult": "I have better things to do than listen to you!", "comeback": "And I have better things to do than to insult your intellect!"},
    {"insult": "You have the intelligence of a two-toed sloth!", "comeback": "And you have the charm of a three-toed one!"},
    {"insult": "Your face is so ugly it could scare a monkey off a banana tree!", "comeback": "Your face is so plain it could pass for a blank wall!"},
    {"insult": "I'm not saying you're stupid, but...", "comeback": "Oh, please, just say it. You're predictable."},
    {"insult": "Is that the best you can do?", "comeback": "Is that the best you can ask?"},
]

def start_new_game(sender_name, shared_state, total_rounds=5):
    print("[DEBUG] start_new_game function reached.") # Add this
    """Initializes a new insult game."""
    shared_state.insult_game_active = True
    shared_state.insult_game_target_sender = sender_name
    shared_state.insult_game_current_insult_index = None # Will be set when bot gives first insult
    shared_state.insult_game_player_wins = 0
    shared_state.insult_game_bot_wins = 0
    shared_state.insult_game_total_rounds = total_rounds
    shared_state.insult_game_last_interaction = datetime.datetime.now() # To time out games
    # Reset used insults for a new game
    shared_state.insult_game_used_indices = set()
    return True

def stop_game(shared_state):
    print("[DEBUG] stop_game function reached.") # Add this
    """Resets the insult game state."""
    shared_state.insult_game_active = False
    shared_state.insult_game_target_sender = None
    shared_state.insult_game_current_insult_index = None
    shared_state.insult_game_player_wins = 0
    shared_state.insult_game_bot_wins = 0
    shared_state.insult_game_total_rounds = 0
    shared_state.insult_game_last_interaction = None
    shared_state.insult_game_used_indices = set()
    return "The insult game has ended. My witty circuits need a rest."

def get_next_bot_insult(shared_state):
    print("[DEBUG] get_next_bot_insult function reached.") # Add this
    """
    Selects a random insult not yet used in the current game,
    stores its index, and returns the insult text.
    """
    if not shared_state.insult_game_active:
        return "No game active. Start one with `bot.insults start`!"

    available_indices = [
        i for i in range(len(INSULTS_AND_COMEBACKS))
        if i not in shared_state.insult_game_used_indices
    ]

    if not available_indices:
        # If all insults have been used, reset for this game to allow repetition,
        # or consider ending the game if you prefer finite insults.
        print("[DEBUG] All insults used, resetting available insults for game.")
        shared_state.insult_game_used_indices.clear()
        available_indices = list(range(len(INSULTS_AND_COMEBACKS)))
        if not available_indices: # Should not happen unless INSULTS_AND_COMEBACKS is empty
            return "Uh oh, I'm out of insults! This game is harder than it looks."

    chosen_index = random.choice(available_indices)
    shared_state.insult_game_current_insult_index = chosen_index
    shared_state.insult_game_used_indices.add(chosen_index)
    shared_state.insult_game_last_interaction = datetime.datetime.now() # Update interaction time
    return INSULTS_AND_COMEBACKS[chosen_index]["insult"]

def check_comeback(user_text, shared_state):
    print("[DEBUG] check_comeback function reached.") # Add this
    """
    Checks if the user's text is the correct comeback for the current insult.
    Updates game state and returns a response.
    """
    if not shared_state.insult_game_active or shared_state.insult_game_current_insult_index is None:
        return "I wasn't expecting a comeback! Are you playing a game with yourself? Start a game with `bot.insults start`."

    current_insult_data = INSULTS_AND_COMEBACKS[shared_state.insult_game_current_insult_index]
    expected_comeback = current_insult_data["comeback"].lower().strip()
    user_comeback = user_text.lower().strip()

    shared_state.insult_game_last_interaction = datetime.datetime.now() # Update interaction time

    # Very loose matching for now to make it a bit more forgiving
    # Checks if the expected comeback is a substring of the user's response.
    if expected_comeback in user_comeback:
        shared_state.insult_game_player_wins += 1
        response = f"A brilliant retort! You parry my insult with wit! (Current Score: Player {shared_state.insult_game_player_wins} - Bot {shared_state.insult_game_bot_wins})\n"
    else:
        shared_state.insult_game_bot_wins += 1
        response = f"Ha! A pathetic attempt! My verbal blade pierces your defenses! The correct comeback was: '{current_insult_data['comeback']}' (Current Score: Player {shared_bot_state.insult_game_player_wins} - Bot {shared_bot_state.insult_game_bot_wins})\n"

    # After a comeback, clear the current insult to prepare for the next round
    shared_state.insult_game_current_insult_index = None

    # Check if the game is over
    if shared_state.insult_game_player_wins + shared_bot_state.insult_game_bot_wins >= shared_bot_state.insult_game_total_rounds:
        final_score = f"FINAL SCORE: Player {shared_bot_state.insult_game_player_wins} - Bot {shared_bot_state.insult_game_bot_wins}.\n"
        if shared_bot_state.insult_game_player_wins > shared_bot_state.insult_game_bot_wins:
            response += f"{final_score}Amazing! You have bested me in a duel of wits! I yield, for now... 😭"
        elif shared_bot_state.insult_game_player_wins < shared_bot_state.insult_game_bot_wins:
            response += f"{final_score}Mwahaha! I, the Bot, am the undisputed master of insults! Better luck next time, human! 😎"
        else:
            response += f"{final_score}A tie! How... anticlimactic. We shall meet again to settle this verbal war!"
        stop_game(shared_bot_state) # End the game
        return response
    else:
        # If the game is not over, the bot delivers the next insult
        next_insult = get_next_bot_insult(shared_bot_state)
        response += f"\nPrepare yourself! Next insult: '{next_insult}'"
        return response