# app/commands/fact.py
import html
import requests


class FactCommand:
    """Returns a random fun fact from uselessfacts (keyless)."""

    def get_required_context(self):
        return []

    def execute(self, config, message_text, context):
        timeout_seconds = int(config.get("fact_timeout_seconds", 8))
        try:
            response = requests.get(
                "https://uselessfacts.jsph.pl/api/v2/facts/random",
                params={"language": "en"},
                timeout=timeout_seconds,
            )
            if response.status_code == 200:
                fact = str(response.json().get("text", "")).strip()
                if fact:
                    return f"🧠 {html.unescape(fact)}"
        except (requests.RequestException, ValueError):
            pass
        return "My fact machine is out of order. Try again soon!"
