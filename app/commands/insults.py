# app/commands/insults.py
from shared_state import shared_bot_state
import insults_game

class InsultsCommand:
    def get_required_context(self):
        """This command requires the sender's name."""
        return ["sender_name"]

    def execute(self, config, message_text, context):
        """
        Handles the insult sword fighting mini-game start/stop.
        """
        sender_name = context.get("sender_name")
        if not sender_name:
            return "Error: Could not determine sender for insult game."

        message_lower = message_text.lower().strip()

        # Check for 'start' command
        if message_lower == "bot.insults start":
            if shared_bot_state.insult_game_active:
                if shared_bot_state.insult_game_target_sender == sender_name:
                    return "We are already in a heated verbal duel! Give me your comeback or type `bot.insults stop` to surrender. You currently have " + \
                           f"{shared_bot_state.insult_game_player_wins} wins and I have {shared_bot_state.insult_game_bot_wins} wins."
                else:
                    return f"Another human ({shared_bot_state.insult_game_target_sender}) is currently locked in a battle of wits with me. Wait your turn!"
            else:
                insults_game.start_new_game(sender_name, shared_bot_state)
                first_insult = insults_game.get_next_bot_insult(shared_bot_state)
                return (
                    f"A challenger approaches! Prepare yourself, {sender_name}, for an Insult Duel!\n"
                    "Your goal: deliver the *correct* witty comeback to my insults.\n"
                    "Type `bot.insults stop` to yield. First to win 3 rounds wins the game!\n\n"
                    f"I shall begin! '{first_insult}'"
                )

        # Check for 'stop' command
        elif message_lower == "bot.insults stop":
            if shared_bot_state.insult_game_active and shared_bot_state.insult_game_target_sender == sender_name:
                return insults_game.stop_game(shared_bot_state) + " You wisely retreated from my verbal onslaught."
            else:
                return "There's no insult game active with you to stop, brave warrior."

        # If it's not a recognized 'bot.insults' sub-command
        else:
            return "To play Insult Sword Fighting, type `bot.insults start`. To quit, type `bot.insults stop`."