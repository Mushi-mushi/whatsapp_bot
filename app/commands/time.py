# app/commands/time.py
from datetime import datetime

def execute(config, message_text): # Add message_text here
    """
    Returns the current time, formatted according to the template in the config.
    """
    template = config.get('keyword_responses', {}).get('bot.time', "Error: Time template not found.")
    now = datetime.now()
    current_time_str = now.strftime("%H:%M:%S on %Y-%m-%d")
    return template.replace("{{current_time}}", current_time_str)