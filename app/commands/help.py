# app/commands/help.py

class HelpCommand:
    def get_required_context(self):
        """This command doesn't need any special context."""
        return []

    def execute(self, config, message_text, context):
        """
        Returns a list of all dynamically configured commands.
        """
        available_commands = sorted(config.get("dynamic_commands", {}).keys())
        if available_commands:
            commands_list = "\n".join([f"- {cmd}" for cmd in available_commands])
            return f"Greetings, curious human! Here are the mystical incantations (commands) I currently understand:\n\n{commands_list}\n\n" \
                   "Use them wisely, or I might just declare a siesta."
        else:
            return "Woe is me! My developers forgot to teach me any commands! I'm just a pretty face... or, well, a command-line interface."