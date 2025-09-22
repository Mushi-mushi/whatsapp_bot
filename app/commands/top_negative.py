# app/commands/top_negative.py
from log_reader import read_log_file

def execute(config, message_text):
    """Finds and formats the top 5 most negative messages from the log."""
    log_entries = read_log_file()

    if not log_entries:
        return "No sentiment data has been logged yet."

    # Sort entries by Polarity Score in ascending order (most negative first)
    sorted_negative = sorted(log_entries, key=lambda x: x['Polarity Score'])
    
    # Get the top 5
    top_5 = sorted_negative[:5]

    reply = "Top 5 Most Negative Logged Messages:\n\n"
    if not top_5:
        return "No negative messages have been logged yet."

    for i, entry in enumerate(top_5):
        reply += (
            f"{i+1}. Sender: {entry['Sender']}\n"
            f"   Score: {entry['Polarity Score']:.2f}\n"
            f"   Message: \"{entry['Message']}\"\n\n"
        )
        
    return reply.strip()