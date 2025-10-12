# app/commands/score.py
from log_reader import read_log_file

# Define the levels and the score required to reach them.
# This is easily expandable in the future.
LEVELS = [
    {"name": "Le Tourist 🗼", "threshold": 0},
    {"name": "Le Francophile 🧀", "threshold": 10},
    {"name": "Le \"Débrouillard\" 🍷", "threshold": 20},
    {"name": "Le \"Râleur\" 🥐", "threshold": 30},
    {"name": "Le \"Bon Vivant\" 🥖", "threshold": 40}
]

class ScoreCommand:
    def get_required_context(self):
        # This command can be called with or without a name.
        # If no name is provided, it will use the current sender's name.
        return ["sender_name"]

    def execute(self, config, message_text, context):
        """Calculates the total sentiment score and determines the level for a sender."""
        
        parts = message_text.strip().split()
        
        # Determine who to check the score for.
        if len(parts) > 1:
            # User specified a name, e.g., "bot.score John Doe"
            sender_to_find = " ".join(parts[1:])
        else:
            # No name specified, use the name of the person who sent the command
            sender_to_find = context.get("sender_name")
        
        if not sender_to_find:
            return "Usage: bot.score <Sender Name> (or just 'bot.score' to check your own)."

        log_entries = read_log_file()
        if not log_entries:
            return f"No sentiment data has been logged yet for '{sender_to_find}'."
            
        total_score = 0
        message_count = 0
        
        # Iterate through logs and sum scores for the specified sender
        for entry in log_entries:
            if entry['Sender'].lower() == sender_to_find.lower():
                total_score += entry['Polarity Score']
                message_count += 1
                
        if message_count == 0:
            return f"No logged messages found for sender: '{sender_to_find}'"
            
        # --- START: NEW LEVELING LOGIC ---
        
        current_level = LEVELS[0]
        next_level = None
        level_index = -1

        # Determine the user's current level by checking thresholds in reverse
        for i, level in reversed(list(enumerate(LEVELS))):
            if total_score >= level["threshold"]:
                current_level = level
                level_index = i
                break
        
        # Determine the next level and progress
        if level_index < len(LEVELS) - 1:
            next_level = LEVELS[level_index + 1]
            points_needed = next_level["threshold"] - total_score
            progress_line = f"Next Level: {points_needed:.2f} points to reach {next_level['name']}"
        else:
            progress_line = "You have reached the highest level!"

        # --- END: NEW LEVELING LOGIC ---
            
        # Assemble the final, formatted reply
        return (
            f"- Current Level: {current_level['name']}\n"
            f"- Total Score: {total_score:.2f}\n"
            f"- {progress_line}\n"
            f"- Based on {message_count} analyzed message(s)."
        )