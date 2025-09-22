# app/commands/score.py
from log_reader import read_log_file

def execute(config, message_text):
    """Calculates the total sentiment score for a given sender."""
    # Split the original message to get potential arguments
    parts = message_text.strip().split()
    
    # Check if there are enough parts for a command and a sender name
    if len(parts) < 2:
        return "Usage: bot.score <Sender Name>"
    
    # The sender name is everything after the first part (the command)
    sender_to_find = " ".join(parts[1:])
    
    log_entries = read_log_file()
    if not log_entries:
        return "No sentiment data has been logged yet."
        
    total_score = 0
    message_count = 0
    
    # Iterate through logs and sum scores for the specified sender (case-insensitively)
    for entry in log_entries:
        if entry['Sender'].lower() == sender_to_find.lower():
            total_score += entry['Polarity Score']
            message_count += 1
            
    if message_count == 0:
        return f"No logged messages found for sender: '{sender_to_find}'"
        
    return (
        f"Sentiment Score for '{sender_to_find}':\n"
        f"- Total Score: {total_score:.2f}\n"
        f"- Based on {message_count} analyzed message(s)."
    )