# app/bot.py

import time
import json
from selenium import webdriver
from selenium.webdriver.chrome.service import Service
from selenium.webdriver.common.by import By
from selenium.webdriver.support.ui import WebDriverWait
from selenium.webdriver.support import expected_conditions as EC
from selenium.common.exceptions import TimeoutException, NoSuchElementException
from selenium.webdriver.common.keys import Keys
from textblob import TextBlob

from shared_state import shared_bot_state
from command_handler import handle_command
from analyzers import sentiment_analyzer
import logger

# --- Configuration & Selectors ---
CONFIG_PATH = 'config/config.json'
USER_DATA_DIR = 'user_data/session'
WHATSAPP_URL = 'https://web.whatsapp.com/'

QR_CODE_XPATH = "//div[@data-ref]"
LOGGED_IN_MARKER_XPATH = "//div[@id='side']//div[@aria-label='Search input textbox']"
UNREAD_CHAT_CONTAINER_XPATH = "//div[@role='listitem'][.//span[contains(@aria-label, 'unread message')]]"
SENDER_NAME_IN_LIST_XPATH = ".//span[@title]"
LAST_MESSAGE_CONTAINER_XPATH = "(//div[contains(@class, 'message-in')])[last()]"
AUDIO_PLAYER_IN_MSG_XPATH = ".//button[@aria-label='Play voice message']"
TEXT_IN_MSG_XPATH = ".//span[contains(@class, 'selectable-text')]"
MESSAGE_INPUT_BOX_XPATH = "//div[@id='main']//footer//div[@role='textbox']"


def load_config():
    """Loads config from file, creating a default one if it's missing or invalid."""
    try:
        with open(CONFIG_PATH, 'r') as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        print("WARNING: config.json not found or invalid. Using default config.")
        return {
            "openai_api_key": "PASTE_YOUR_OPENAI_API_KEY_HERE",
            "transcription_enabled": True,
            "dynamic_commands": {},
            "keyword_responses": {"hello": "Default response: Hello!"},
            "approved_senders": []
        }

def setup_driver():
    """Sets up the Chrome driver."""
    options = webdriver.ChromeOptions()
    options.add_argument("--no-sandbox")
    options.add_argument("--headless=new")
    options.add_argument("--disable-gpu")
    options.add_argument("--window-size=1920,1080")
    options.add_argument("--disable-extensions")
    options.add_argument(f"user-data-dir={USER_DATA_DIR}")
    service = Service() 
    return webdriver.Chrome(service=service, options=options)


def run_bot():
    print("Starting bot...")
    shared_bot_state.status = "STARTING"
    driver = setup_driver()

    try:
        # --- Login Logic (Correct) ---
        driver.get(WHATSAPP_URL)
        print("Loading WhatsApp Web, please wait...")
        WebDriverWait(driver, 60).until(
            EC.presence_of_element_located((By.XPATH, f"{QR_CODE_XPATH} | {LOGGED_IN_MARKER_XPATH}"))
        )
        print("Page loaded. Checking login status...")
        try:
            driver.find_element(By.XPATH, LOGGED_IN_MARKER_XPATH)
            shared_bot_state.status = "LOGGED_IN"
            print("Bot is logged in and running.")
        except NoSuchElementException:
            print("QR code found. Displaying on Web UI.")
            shared_bot_state.status = "NEEDS_LOGIN"
            while shared_bot_state.status == "NEEDS_LOGIN":
                try:
                    qr_element = driver.find_element(By.XPATH, QR_CODE_XPATH)
                    qr_b64 = qr_element.screenshot_as_base64
                    shared_bot_state.qr_code_base64 = qr_b64
                    time.sleep(1)
                except NoSuchElementException:
                    shared_bot_state.status = "LOGGED_IN"
                    shared_bot_state.qr_code_base64 = None
                    print("Login successful! Bot is running.")
        
        # --- Main Bot Loop ---
        config = load_config()
        last_config_check_time = time.time()
        
        while True:
            try:
                WebDriverWait(driver, 20).until(
                    EC.presence_of_element_located((By.XPATH, LOGGED_IN_MARKER_XPATH))
                )
                if shared_bot_state.status != "LOGGED_IN":
                    break

                current_time = time.time()
                if current_time - last_config_check_time > 60:
                    print("[DEBUG] Reloading configuration...")
                    config = load_config()
                    last_config_check_time = current_time

                unread_chat_containers = driver.find_elements(By.XPATH, UNREAD_CHAT_CONTAINER_XPATH)
                
                if unread_chat_containers:
                    print(f"[DEBUG] Found {len(unread_chat_containers)} unread chat(s).")
                    chat_container = unread_chat_containers[0]
                    
                    # We wrap this in a try/except to handle cases where the element might disappear
                    # during a page refresh initiated by a previous loop iteration.
                    try:
                        sender_element = chat_container.find_element(By.XPATH, SENDER_NAME_IN_LIST_XPATH)
                        sender_name = sender_element.get_attribute("title").strip()
                        print(f"[DEBUG] Found unread message from: '{sender_name}'")

                        if sender_name in config.get('approved_senders', []):
                            print(f"[INFO] Sender '{sender_name}' is APPROVED. Processing...")
                            chat_container.click()
                            time.sleep(2)

                            last_message_container = WebDriverWait(driver, 10).until(
                                EC.presence_of_element_located((By.XPATH, LAST_MESSAGE_CONTAINER_XPATH))
                            )
                            
                            is_audio = False
                            try:
                                last_message_container.find_element(By.XPATH, AUDIO_PLAYER_IN_MSG_XPATH)
                                is_audio = True
                            except NoSuchElementException:
                                is_audio = False

                            reply_text = None

                            if is_audio:
                                print("[DEBUG] Audio message detected.")
                                reply_text = "No voice message allowed"
                            else:
                                print("[DEBUG] Assuming text message.")
                                message_text_original = last_message_container.find_element(By.XPATH, TEXT_IN_MSG_XPATH).text.strip()
                                message_text_lower = message_text_original.lower()
                                print(f"[DEBUG] Read text: '{message_text_original}'")
                                
                                reply_text = sentiment_analyzer.analyze(message_text_original)
                                if reply_text:
                                    blob = TextBlob(message_text_original)
                                    polarity = blob.sentiment.polarity
                                    sentiment = "Positive" if polarity > 0.1 else "Negative" if polarity < -0.1 else "Neutral"
                                    logger.log_sentiment(sender_name, sentiment, polarity, message_text_original)
                                
                                if reply_text is None:
                                    reply_text = handle_command(message_text_lower, config, message_text_original)
                                
                                if reply_text is None and message_text_lower in config.get('keyword_responses', {}):
                                    reply_text = config['keyword_responses'][message_text_lower]

                            if reply_text:
                                print(f"[DEBUG] Preparing to send reply:\n{reply_text}")
                                input_box = WebDriverWait(driver, 10).until(EC.element_to_be_clickable((By.XPATH, MESSAGE_INPUT_BOX_XPATH)))
                                driver.execute_script("arguments[0].innerText = arguments[1];", input_box, reply_text)
                                input_box.send_keys(Keys.ENTER)
                                print(f"[SUCCESS] Sent reply.")
                            else:
                                print("[DEBUG] No matching analyzer, command, or keyword found.")
                            
                            time.sleep(2)
                            print("[DEBUG] Refreshing page to find next message...")
                            driver.refresh()
                            # *** NO BREAK STATEMENT HERE ***
                        else:
                            print(f"[INFO] Sender '{sender_name}' is NOT approved. Clicking to mark as read.")
                            chat_container.click()
                            time.sleep(2)
                            driver.refresh()
                            # *** NO BREAK STATEMENT HERE ***

                    except Exception as e:
                        print(f"[ERROR] An error occurred while processing a chat item: {e}. Refreshing to recover.")
                        driver.refresh()
                        # *** NO BREAK STATEMENT HERE ***
                
                print("[DEBUG] Waiting for next cycle...")
                time.sleep(5)

            except (NoSuchElementException, TimeoutException):
                print("[ERROR] Could not find the logged-in marker. Assuming logged out.")
                shared_bot_state.status = "CRASHED"
                break
            except Exception as e:
                print(f"[CRITICAL] An unexpected error occurred in the main loop: {e}")
                driver.save_screenshot("critical_error_screenshot.png")
                shared_bot_state.status = "CRASHED"
                time.sleep(10)
                break

    except Exception as e:
        print(f"A critical error occurred during bot startup: {e}")
        
    finally:
        print("Bot is shutting down.")
        driver.quit()