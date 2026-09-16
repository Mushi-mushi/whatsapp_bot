# app/commands/weather.py
import re
import requests


class WeatherCommand:
    """Fetches a one-line current weather summary from wttr.in (keyless)."""

    def get_required_context(self):
        return []

    def execute(self, config, message_text, context):
        city = self._extract_city(message_text)
        if not city:
            return "Usage: bot.weather <city>  (e.g. bot.weather Barcelona)"

        timeout_seconds = int(config.get("weather_timeout_seconds", 8))
        encoded_city = requests.utils.quote(city)
        # wttr.in's TLS cert intermittently expires; fall back to http for this plain text.
        for scheme in ("https", "http"):
            try:
                response = requests.get(
                    f"{scheme}://wttr.in/{encoded_city}",
                    params={"format": "3"},
                    headers={"User-Agent": "curl/8"},
                    timeout=timeout_seconds,
                )
                if response.status_code == 200 and response.text.strip():
                    return f"🌤️ {response.text.strip()}"
            except requests.RequestException:
                continue
        return f"Could not fetch the weather for '{city}' right now."

    def _extract_city(self, message_text):
        text = re.sub(r"\s+\d{1,2}:\d{2}\s*$", "", str(message_text or "")).strip()
        match = re.search(r"(?i)bot\.weather\b\s*(.*)$", text)
        return match.group(1).strip() if match else ""
