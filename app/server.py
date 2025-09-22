# app/server.py

import json
from flask import Flask, render_template, request, jsonify
from waitress import serve

from shared_state import shared_bot_state

CONFIG_PATH = 'config/config.json'
app = Flask(__name__)

def load_config():
    """Loads config from file."""
    try:
        with open(CONFIG_PATH, 'r') as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        # If the file is bad, return a safe default
        return {
            "openai_api_key": "",
            "transcription_enabled": False,
            "keyword_responses": {}
        }

def save_config(config_data):
    """Saves config to file."""
    with open(CONFIG_PATH, 'w') as f:
        json.dump(config_data, f, indent=2)

@app.route('/', methods=['GET', 'POST'])
def index():
    saved = False
    if request.method == 'POST':
        try:
            keywords_dict = json.loads(request.form['keyword_responses'])
            new_config = {
                "openai_api_key": request.form.get('openai_api_key', ''),
                "transcription_enabled": 'transcription_enabled' in request.form,
                "keyword_responses": keywords_dict
            }
            save_config(new_config)
            saved = True
        except (json.JSONDecodeError, KeyError) as e:
            print(f"Error saving config: Invalid format. {e}")
            pass 
            
    config = load_config()
    
    # We just pass the entire, clean config object to the template.
    return render_template('index.html', config=config, saved=saved)

@app.route('/status')
def status():
    """Provides the bot's status and QR code to the frontend."""
    return jsonify({
        'status': shared_bot_state.status,
        'qr_image': shared_bot_state.qr_code_base64
    })
    
def run_server():
    """Runs the production-grade web server."""
    print("Starting production server on http://0.0.0.0:5000")
    serve(app, host='0.0.0.0', port=5000)