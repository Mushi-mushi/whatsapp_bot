# app/commands/eightball.py
import random
import re


class EightballCommand:
    """Magic 8-Ball. Local answers only: instant, no network, never fails."""

    ANSWERS = [
        "It is certain.",
        "It is decidedly so.",
        "Without a doubt.",
        "Yes, definitely.",
        "You may rely on it.",
        "As I see it, yes.",
        "Most likely.",
        "Outlook good.",
        "Yes.",
        "Signs point to yes.",
        "Reply hazy, try again.",
        "Ask again later.",
        "Better not tell you now.",
        "Cannot predict now.",
        "Concentrate and ask again.",
        "Don't count on it.",
        "My reply is no.",
        "My sources say no.",
        "Outlook not so good.",
        "Very doubtful.",
    ]

    def get_required_context(self):
        return []

    def execute(self, config, message_text, context):
        question = self._extract_question(message_text)
        answer = random.choice(self.ANSWERS)
        if question:
            return f"🎱 Q: {question}\nA: {answer}"
        return f"🎱 {answer}"

    def _extract_question(self, message_text):
        text = re.sub(r"\s+\d{1,2}:\d{2}\s*$", "", str(message_text or "")).strip()
        match = re.search(r"(?i)bot\.8ball\b\s*(.*)$", text)
        return match.group(1).strip() if match else ""
