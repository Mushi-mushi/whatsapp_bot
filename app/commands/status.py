# app/commands/status.py
import datetime
from shared_state import shared_bot_state
import insults_game # We need this to get insult text if a game is active

class StatusCommand:
    def get_required_context(self):
        """This command doesn't need any special context."""
        return []

    def execute(self, config, message_text, context):
        """
        Provides the current operational status of the bot,
        including siesta, torture, and insult game states.
        """
        status_message = f"🤖 **Bot Status Report** 🤖\n\n"
        status_message += f"**Overall Health**: {shared_bot_state.status}\n"

        # Siesta Status
        if shared_bot_state.siesta_until:
            now = datetime.datetime.now()
            if now < shared_bot_state.siesta_until:
                remaining = shared_bot_state.siesta_until - now
                minutes = int(remaining.total_seconds() / 60)
                seconds = int(remaining.total_seconds() % 60)
                status_message += f"**Siesta Mode**: Active! Resting for {minutes}m {seconds}s more. Shhh... 😴\n"
            else:
                status_message += "**Siesta Mode**: Just woke up! Ready for more shenanigans! ☕\n"
        else:
            status_message += "**Siesta Mode**: Inactive. My circuits are buzzing! ✨\n"

        # Torture Status
        if shared_bot_state.torture_active:
            status_message += f"**Torture Protocol**: Active! Currently delighting {shared_bot_state.torture_target_sender} with witty spam! 😈\n"
        else:
            status_message += "**Torture Protocol**: Inactive. My mischievous impulses are contained... for now. 😇\n"

        # Insult Game Status
        if shared_bot_state.insult_game_active:
            status_message += (
                f"**Insult Duel**: Active! Opponent: {shared_bot_state.insult_game_target_sender}\n"
                f"  Score: Player {shared_bot_state.insult_game_player_wins} - Bot {shared_bot_state.insult_game_bot_wins}\n"
            )
            if shared_bot_state.insult_game_current_insult_index is not None:
                current_insult = insults_game.INSULTS_AND_COMEBACKS[shared_bot_state.insult_game_current_insult_index]['insult']
                status_message += f"  Bot's Last Insult: '{current_insult}' (Awaiting comeback!)\n"
            else:
                status_message += "  (Bot waiting to deliver next insult or for game to end)\n"
        else:
            status_message += "**Insult Duel**: Inactive. My verbal rapier is sheathed. ⚔️\n"

        return status_message