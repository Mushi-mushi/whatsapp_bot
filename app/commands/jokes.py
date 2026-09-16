# app/commands/jokes.py
import html
import requests


class JokesCommand:
    """Fetches a random joke from public keyless joke APIs, with layered fallbacks."""

    def get_required_context(self):
        return []

    def execute(self, config, message_text, context):
        timeout_seconds = int(config.get("joke_timeout_seconds", 8))

        joke = self._from_icanhazdadjoke(timeout_seconds)
        if not joke:
            joke = self._from_official_joke_api(timeout_seconds)
        if not joke:
            joke = self._from_jokeapi(timeout_seconds)

        if joke:
            return f"😂 {joke}"
        return "I reached for a joke but the internet ghosted me. Try again in a moment!"

    def _from_icanhazdadjoke(self, timeout_seconds):
        try:
            response = requests.get(
                "https://icanhazdadjoke.com/",
                headers={"Accept": "application/json", "User-Agent": "whatsapp-bot (jokes command)"},
                timeout=timeout_seconds,
            )
            if response.status_code == 200:
                joke = str(response.json().get("joke", "")).strip()
                return html.unescape(joke) or None
        except (requests.RequestException, ValueError):
            pass
        return None

    def _from_official_joke_api(self, timeout_seconds):
        try:
            response = requests.get(
                "https://official-joke-api.appspot.com/random_joke",
                timeout=timeout_seconds,
            )
            if response.status_code == 200:
                data = response.json()
                setup = str(data.get("setup", "")).strip()
                punchline = str(data.get("punchline", "")).strip()
                if setup and punchline:
                    return html.unescape(f"{setup}\n{punchline}")
        except (requests.RequestException, ValueError):
            pass
        return None

    def _from_jokeapi(self, timeout_seconds):
        try:
            response = requests.get(
                "https://v2.jokeapi.dev/joke/Any",
                params={"safe-mode": "", "type": "single"},
                timeout=timeout_seconds,
            )
            if response.status_code == 200:
                data = response.json()
                joke = str(data.get("joke", "")).strip()
                return html.unescape(joke) or None
        except (requests.RequestException, ValueError):
            pass
        return None
