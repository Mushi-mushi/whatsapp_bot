# app/commands/quote.py
import html
import requests


class QuoteCommand:
    """Returns a random quote from zenquotes, falling back to quotable (both keyless)."""

    def get_required_context(self):
        return []

    def execute(self, config, message_text, context):
        timeout_seconds = int(config.get("quote_timeout_seconds", 8))
        quote = self._from_zenquotes(timeout_seconds) or self._from_quotable(timeout_seconds)
        if quote:
            return f"💬 {quote}"
        return "The muses are quiet right now. Try again later!"

    def _from_zenquotes(self, timeout_seconds):
        try:
            response = requests.get("https://zenquotes.io/api/random", timeout=timeout_seconds)
            if response.status_code == 200:
                data = response.json()
                if isinstance(data, list) and data:
                    text = str(data[0].get("q", "")).strip()
                    author = str(data[0].get("a", "")).strip()
                    if text:
                        return f"\"{html.unescape(text)}\" — {author or 'Unknown'}"
        except (requests.RequestException, ValueError):
            pass
        return None

    def _from_quotable(self, timeout_seconds):
        try:
            response = requests.get("https://api.quotable.io/random", timeout=timeout_seconds)
            if response.status_code == 200:
                data = response.json()
                text = str(data.get("content", "")).strip()
                author = str(data.get("author", "")).strip()
                if text:
                    return f"\"{html.unescape(text)}\" — {author or 'Unknown'}"
        except (requests.RequestException, ValueError):
            pass
        return None
