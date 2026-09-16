# app/server.py

import json
from flask import Flask, render_template, request, jsonify
from waitress import serve

from shared_state import shared_bot_state

CONFIG_PATH = 'config/config.json'
KNOWN_CHATS_PATH = 'logs/known_chats.json'
app = Flask(__name__)

DEFAULT_CONFIG = {
    "openai_api_key": "",
    "transcription_enabled": False,
    "transcription_provider": "auralis",
    "auralis_base_url": "http://host.docker.internal:8000",
    "transcription_timeout_seconds": 90,
    "audio_download_enabled": False,
    "audio_download_dir": "/downloads/audio",
    "bot_reply_prefix": "🤖 *WhatsApp Bot:*",
    "dynamic_commands": {},
    "keyword_responses": {},
    "approved_senders": [],
}


def _normalize_map(value):
    """Return a dict[str, str] from arbitrary input."""
    if not isinstance(value, dict):
        return {}
    normalized = {}
    for k, v in value.items():
        key = str(k).strip()
        if not key:
            continue
        normalized[key] = str(v).strip()
    return normalized


def _normalize_list(value):
    """Return a list[str] from arbitrary input, removing blanks and duplicates."""
    if not isinstance(value, list):
        return []
    seen = set()
    cleaned = []
    for item in value:
        text = str(item).strip()
        if not text or text in seen:
            continue
        seen.add(text)
        cleaned.append(text)
    return cleaned


def normalize_config(raw_config):
    """Coerces incoming config to a safe, complete schema."""
    config = dict(DEFAULT_CONFIG)
    if not isinstance(raw_config, dict):
        return config

    config["openai_api_key"] = str(raw_config.get("openai_api_key", "")).strip()
    config["transcription_enabled"] = bool(raw_config.get("transcription_enabled", False))
    provider = str(raw_config.get("transcription_provider", "auralis")).strip().lower()
    config["transcription_provider"] = provider if provider else "auralis"
    config["auralis_base_url"] = str(raw_config.get("auralis_base_url", "http://host.docker.internal:8000")).strip() or "http://host.docker.internal:8000"
    try:
        timeout_seconds = int(raw_config.get("transcription_timeout_seconds", 90))
    except (TypeError, ValueError):
        timeout_seconds = 90
    config["transcription_timeout_seconds"] = max(5, timeout_seconds)
    config["audio_download_enabled"] = bool(raw_config.get("audio_download_enabled", False))
    config["audio_download_dir"] = str(raw_config.get("audio_download_dir", "/downloads/audio")).strip() or "/downloads/audio"
    config["bot_reply_prefix"] = str(raw_config.get("bot_reply_prefix", "🤖 *WhatsApp Bot:*"))
    config["dynamic_commands"] = _normalize_map(raw_config.get("dynamic_commands", {}))
    config["keyword_responses"] = _normalize_map(raw_config.get("keyword_responses", {}))
    config["approved_senders"] = _normalize_list(raw_config.get("approved_senders", []))
    return config

def load_config():
    """Loads config from file."""
    try:
        with open(CONFIG_PATH, 'r') as f:
            return normalize_config(json.load(f))
    except (FileNotFoundError, json.JSONDecodeError):
        # If the file is missing/corrupt, return a safe default schema.
        return dict(DEFAULT_CONFIG)

def save_config(config_data):
    """Saves config to file."""
    with open(CONFIG_PATH, 'w') as f:
        json.dump(normalize_config(config_data), f, indent=2)

@app.route('/', methods=['GET'])
def index():
    return render_template('index.html')


@app.route('/api/config', methods=['GET'])
def get_config_api():
    """Returns the full editable config schema."""
    return jsonify(load_config())


@app.route('/api/config', methods=['POST', 'PUT'])
def save_config_api():
    """Saves full config payload from frontend editor."""
    payload = request.get_json(silent=True)
    if not isinstance(payload, dict):
        return jsonify({"ok": False, "error": "Expected JSON object payload."}), 400

    config = normalize_config(payload)
    save_config(config)
    return jsonify({"ok": True, "config": config})

@app.route('/status')
def status():
    """Provides the bot's status and QR code to the frontend."""
    return jsonify({
        'status': shared_bot_state.status,
        'qr_image': shared_bot_state.qr_code_base64
    })


@app.route('/api/status')
def status_api():
    """Alias for status endpoint used by dashboard scripts."""
    return status()


@app.route('/api/chats')
def chats_api():
    """Returns chat titles the bot has seen in the WhatsApp sidebar, for the approve picker."""
    try:
        with open(KNOWN_CHATS_PATH, 'r') as f:
            data = json.load(f)
        chats = data.get("chats", []) if isinstance(data, dict) else []
        updated_at = data.get("updated_at") if isinstance(data, dict) else None
    except (FileNotFoundError, json.JSONDecodeError, OSError):
        chats, updated_at = [], None
    if not isinstance(chats, list):
        chats = []
    return jsonify({"chats": [str(c) for c in chats], "updated_at": updated_at})

def run_server():
    """Runs the production-grade web server."""
    print("Starting production server on http://0.0.0.0:5000")
    serve(app, host='0.0.0.0', port=5000)