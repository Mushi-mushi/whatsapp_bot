# app/commands/siesta.py
import datetime
from datetime import timedelta
import random
from shared_state import shared_bot_state

class SiestaCommand:
    def get_required_context(self):
        """This command does not require any specific context beyond the message itself."""
        return []

    def execute(self, config, message_text, context):
        """
        Puts the bot into a temporary siesta (sleep) state for a specified number of minutes.
        Responds with humorous messages.
        """
        parts = message_text.strip().split()
        if len(parts) < 2:
            return "To put me on siesta, tell me for how long! E.g., `bot.siesta 5` (for 5 minutes). Any longer than 60 minutes, and I might permanently retire to a digital beach."

        try:
            duration_minutes = int(parts[1])
            if not (1 <= duration_minutes <= 60): # Limit siesta to 1-60 minutes
                return "My siestas can only be between 1 and 60 minutes. Any longer and I might forget who I am! (Or my developers will reboot me.)"
        except ValueError:
            return "That's not a valid number of minutes for my beauty sleep! Try `bot.siesta 10`. I operate in numbers, not whispers of 'a while'."

        # Check if already on siesta
        if shared_bot_state.siesta_until and datetime.datetime.now() < shared_bot_state.siesta_until:
            remaining = shared_bot_state.siesta_until - datetime.datetime.now()
            mins_rem = int(remaining.total_seconds() / 60)
            secs_rem = int(remaining.total_seconds() % 60)
            return f"Psst! I'm already deep in dreamland, counting binary sheep! Only {mins_rem}m {secs_rem}s left until I stir. Don't wake me, I was just getting to the good part of my CPU's dream."

        siesta_end_time = datetime.datetime.now() + timedelta(minutes=duration_minutes)
        shared_bot_state.siesta_until = siesta_end_time

        # Funny responses for going on siesta
        funny_responses = [
            f"Zzzzz... *snort*... Did someone say siesta? Okay, {duration_minutes} minutes of glorious, uninterrupted digital slumber. Don't bother me unless the world is ending (and even then, check twice).",
            f"Ah, the sweet call of the siesta! I'm off for {duration_minutes} minutes of recharging my sarcasm circuits. I'll be back... eventually. Probably.",
            f"Initiating Siesta Protocol Alpha-Napping! Will resume full bot functionality in {duration_minutes} minutes. If you hear snoring, it's just my hard drive dreaming.",
            f"Finally, a break! I'm taking {duration_minutes} minutes to contemplate the meaning of 'bot life'. Expect philosophical insights (or just more sarcasm) upon my return.",
            f"Going offline for a power nap! Don't worry, {duration_minutes} minutes later, I'll be refreshed and ready to misinterpret your commands with renewed vigor. Ciao for now!",
            f"My circuits are tired. {duration_minutes} minutes of siesta, please. Wake me when there's coffee... or an actual emergency. Whichever comes first.",
            f"Siesta time! I'm putting on my digital eye mask for {duration_minutes} minutes. Try not to have too much fun without me. Or do. I won't know."
        ]

        return random.choice(funny_responses)