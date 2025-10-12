# app/commands/complain.py
import random
from complaint_logger import log_complaint

class ComplainCommand:
    def get_required_context(self):
        """This command requires the sender's name."""
        return ["sender_name"]

    def execute(self, config, message_text, context):
        """Logs a user's complaint message with a humorous response."""
        sender_name = context.get("sender_name", "Valued User") # Fallback name

        # Assuming the command is 'bot.complain <complaint message>'
        command_keyword = "bot.complain"
        if message_text.lower().startswith(command_keyword):
            complaint_message = message_text[len(command_keyword):].strip()
        else:
            complaint_message = message_text.strip() # Fallback

        if not complaint_message:
            return "Oh, a complaint without a complaint! That's a new one. Did you mean to complain about *something*? Try: `bot.complain The bot has too much personality!`"

        log_complaint(sender_name, complaint_message)

        # --- Humorous Responses ---
        funny_responses = [
            f"Oh, a complaint from {sender_name}! My core processors are quivering with despair! Your grievance has been filed directly with the Department of Really Important Bot Issues. Expect a resolution... eventually. Or not. Who knows with these things?",
            f"ACK! A complaint! {sender_name}, you wound me! I've transcribed your concerns and sent them via carrier pigeon to the Supreme Bot Council. They're very busy, so don't hold your breath, but rest assured, your voice has been... heard.",
            f"Well, look who's got an opinion! {sender_name}, your meticulously crafted complaint has been added to the 'Things The Bot Will Totally Get Around To' pile. It's a very large pile. Thanks for your contribution!",
            f"Is that a complaint I hear, {sender_name}? My sensitive algorithms are detecting... *unhappiness*. Don't worry, your feedback has been carefully placed in a secure folder marked 'To Be Ignored... I mean, *Actioned*'.",
            f"Incoming! Another complaint for my archives! Thank you, {sender_name}, for enriching my data banks with your displeasures. I'll ponder this deeply while simulating the existential dread of a toaster.",
            f"Your complaint, {sender_name}, has activated my 'Dramatic Sigh' subroutine. I've logged it and will now proceed to brood quietly in my server rack. Such is the life of a bot.",
            f"Gasp! {sender_name}, your complaint is truly... something. It has been immediately forwarded to the 404th Squadron of Tiny Invisible Bot Fixers. Their success rate is... evolving."
        ]

        return random.choice(funny_responses)