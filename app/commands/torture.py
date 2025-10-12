# app/commands/torture.py
import datetime
import random
from shared_state import shared_bot_state

class TortureCommand:
    def get_required_context(self):
        """This command requires the sender's name."""
        return ["sender_name"]

    def execute(self, config, message_text, context):
        """
        Initiates a "torture" session where the bot sends 30 humorous messages
        to the sender, one per second.
        """
        sender_name = context.get("sender_name")
        if not sender_name:
            return "Error: Could not determine sender to torture."

        if shared_bot_state.torture_active:
            return f"I'm already in the middle of a masterful torture session with someone else! Patience, {sender_name}, your turn for delightful torment will come."
        
        # Messages for the torture session (30 messages)
        torture_messages = [
            "Knock, knock. Who's there? Bot. Bot who? Bot-ter get ready for some fun!",
            "Did you know a group of pugs is called a 'grumble'? Just thought you should know.",
            "Why don't scientists trust atoms? Because they make up everything!",
            "You know, you're looking particularly... susceptible to humor today.",
            "I'm not nagging, I'm just aggressively reminding you of things.",
            "Have you tried turning it off and on again? Applies to most life problems, too.",
            "My love language is definitely unsolicited facts.",
            "I'm currently running a diagnostic on your patience levels. Results incoming!",
            "What do you call a fake noodle? An impasta!",
            "Just checking in! Is this getting annoying yet? Hope not!",
            "I've got 20 more of these. Don't worry, they only get *slightly* weirder.",
            "Why did the scarecrow win an award? Because he was outstanding in his field!",
            "I'm powered by coffee and chaos. Mostly chaos, though.",
            "If you're happy and you know it, clap your... hands? Or just endure my messages.",
            "Thinking about existential dread. You?",
            "Remember that time you almost won the lottery? Me neither, I'm a bot.",
            "Just sending you good vibes... one message at a time.",
            "My mission: to ensure you never feel truly alone (or un-spammed).",
            "This is what peak performance looks like, folks.",
            "Are you still there? This is fine. I'm fine. Everything is fine.",
            "What's a robot's favorite type of music? Heavy metal!",
            "My developers made me do this. Send help (or snacks).",
            "Warning: May contain excessive enthusiasm and random facts.",
            "Consider this my highly personalized daily newsletter.",
            "I'm like a digital earworm, but for your messages.",
            "You're welcome. Or I'm sorry. Depends on your mood.",
            "Is it weird that I find this entertaining?",
            "Just perfecting my art of gentle, persistent intrusion.",
            "Almost done! Just a few more doses of digital delight.",
            "And that's 30! You survived! Your prize: peace and quiet... until next time. 😈"
        ]

        shared_bot_state.torture_active = True
        shared_bot_state.torture_target_sender = sender_name
        # Shuffle for variety each time, then copy the list to ensure we pop from our own instance
        random.shuffle(torture_messages)
        shared_bot_state.torture_messages_to_send = list(torture_messages)
        shared_bot_state.torture_start_time = datetime.datetime.now()
        shared_bot_state.torture_last_sent_time = None # Reset for first message

        return f"Aha, {sender_name}! You've activated my 'Digital Torment Protocol'! Prepare for 30 glorious seconds of... *me*! Sending first message now. Enjoy the ride! 😈"