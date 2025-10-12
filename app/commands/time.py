# app/commands/time.py
from datetime import datetime

class TimeCommand:
    def get_required_context(self):
        # This command doesn't need any extra info from the bot loop.
        return []

    def execute(self, config, message_text, context):
        """
        Returns the current time, formatted according to the template in the config.
        """
        template = config.get('keyword_responses', {}).get('bot.time', "Error: Time template not found.")
        now = datetime.now()
        current_time_str = now.strftime("%H:%M:%S on %Y-%m-%d")
        return template.replace("{{current_time}}", current_time_str)