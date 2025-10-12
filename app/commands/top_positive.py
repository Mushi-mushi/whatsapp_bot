from log_reader import read_log_file

class TopPositiveCommand:
    def get_required_context(self):
        """This command does not require any specific context."""
        return []

    def execute(self, config, message_text, context):
        """Finds and formats the top 5 most positive messages from the log."""
        log_entries = read_log_file()

        if not log_entries:
            return "No sentiment data has been logged yet."

        # Sort entries by Polarity Score in descending order (most positive first)
        sorted_positive = sorted(log_entries, key=lambda x: x['Polarity Score'], reverse=True)

        # Get the top 5
        top_5 = sorted_positive[:5]

        reply = "Top 5 Most Positive Logged Messages:\n\n"
        if not top_5:
            return "No positive messages have been logged yet."

        for i, entry in enumerate(top_5):
            reply += (
                f"{i+1}. Sender: {entry['Sender']}\n"
                f"   Score: {entry['Polarity Score']:.2f}\n"
                f"   Message: \"{entry['Message']}\"\n\n"
            )

        return reply.strip()