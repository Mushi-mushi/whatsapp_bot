# app/bot.py

import time
import json
import base64
from selenium import webdriver
from selenium.webdriver.chrome.service import Service
from selenium.webdriver.common.by import By
from selenium.webdriver.support.ui import WebDriverWait
from selenium.webdriver.support import expected_conditions as EC
from selenium.common.exceptions import TimeoutException, NoSuchElementException
from selenium.webdriver.common.keys import Keys

from shared_state import shared_bot_state

# --- Configuration ---
CONFIG_PATH = 'config/config.json'
USER_DATA_DIR = 'user_data/session'
WHATSAPP_URL = 'https://web.whatsapp.com/'

# --- XPATH SELECTORS (Definitive Final Version) ---
QR_CODE_XPATH = "//div[@data-ref]"
LOGGED_IN_MARKER_XPATH = "//div[@id='side']//div[@aria-label='Search input textbox']"

# This selector finds the entire chat container DIV, but only if it contains an unread message span inside it.
UNREAD_CHAT_CONTAINER_XPATH = "//div[@role='listitem'][.//span[contains(@aria-label, 'unread message')]]"
# This is a RELATIVE selector to find the sender's name within a chat container. It looks for a span with a 'title' attribute.
SENDER_NAME_IN_LIST_XPATH = ".//span[@title]"

# Selectors for once a chat is open
LAST_MESSAGE_CONTAINER_XPATH = "(//div[contains(@class, 'message-in')])[last()]"
AUDIO_PLAYER_IN_MSG_XPATH = ".//button[@aria-label='Play voice message']"
TEXT_IN_MSG_XPATH = ".//span[contains(@class, 'selectable-text')]"
MESSAGE_INPUT_BOX_XPATH = "//div[@id='main']//footer//div[@role='textbox']"


def load_config():
    # ... (This function is correct) ...
    try:
        with open(CONFIG_PATH, 'r') as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        print("WARNING: config.json not found or invalid. Using default config.")
        return {
            "openai_api_key": "PASTE_YOUR_OPENAI_API_KEY_HERE",
            "transcription_enabled": True,
            "keyword_responses": {"hello": "Default response: Hello!"},
            "approved_senders": []
        }

def setup_driver():
    # ... (This function is correct) ...
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
            # ... (QR code logic is correct) ...
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

                # Find all unread chat containers
                unread_chat_containers = driver.find_elements(By.XPATH, UNREAD_CHAT_CONTAINER_XPATH)
                
                if unread_chat_containers:
                    print(f"[DEBUG] Found {len(unread_chat_containers)} unread chat(s).")
                    approved_senders = config.get('approved_senders', [])
                    
                    # --- START: NEW, SUPERIOR LOGIC ---
                    # Iterate through all unread chats found
                    for chat_container in unread_chat_containers:
                        try:
                            # Extract the sender name *before* clicking
                            sender_element = chat_container.find_element(By.XPATH, SENDER_NAME_IN_LIST_XPATH)
                            sender_name = sender_element.get_attribute("title").strip()
                            print(f"[DEBUG] Found unread message from: '{sender_name}'")

                            # Check against the whitelist
                            if sender_name in approved_senders:
                                print(f"[INFO] Sender '{sender_name}' is APPROVED. Processing...")
                                chat_container.click()
                                time.sleep(2)

                                # Now that we're in the chat, process the last message
                                last_message_container = WebDriverWait(driver, 10).until(
                                    EC.presence_of_element_located((By.XPATH, LAST_MESSAGE_CONTAINER_XPATH))
                                )
                                
                                is_audio = False
                                try:
                                    last_message_container.find_element(By.XPATH, AUDIO_PLAYER_IN_MSG_XPATH)
                                    is_audio = True
                                except NoSuchElementException:
                                    is_audio = False

                                if is_audio:
                                    print("[DEBUG] Audio message detected.")
                                    reply_text = "No voice message allowed"
                                    input_box = WebDriverWait(driver, 10).until(EC.element_to_be_clickable((By.XPATH, MESSAGE_INPUT_BOX_XPATH)))
                                    input_box.send_keys(reply_text + Keys.ENTER)
                                    print(f"[SUCCESS] Sent audio rejection reply.")
                                else:
                                    print("[DEBUG] Assuming text message.")
                                    message_text = last_message_container.find_element(By.XPATH, TEXT_IN_MSG_XPATH).text.lower().strip()
                                    print(f"[DEBUG] Read text: '{message_text}'")
                                    if message_text in config.get('keyword_responses', {}):
                                        reply_text = config['keyword_responses'][message_text]
                                        input_box = WebDriverWait(driver, 10).until(EC.element_to_be_clickable((By.XPATH, MESSAGE_INPUT_BOX_XPATH)))
                                        input_box.send_keys(reply_text + Keys.ENTER)
                                        print(f"[SUCCESS] Sent keyword reply.")
                                    else:
                                        print("[DEBUG] Keyword not found.")
                                
                                # Refresh the page to reset focus and look for the next message
                                time.sleep(2)
                                print("[DEBUG] Refreshing page to find next message...")
                                driver.refresh()
                                # Break out of the inner 'for' loop to start the 'while' loop again from a fresh page state
                                break 
                            else:
                                print(f"[INFO] Sender '{sender_name}' is NOT approved. Skipping.")

                        except Exception as e:
                            print(f"[ERROR] An error occurred while processing a chat item: {e}")
                            # Refresh to try and recover from a bad state
                            driver.refresh()
                            break
                    # --- END: NEW, SUPERIOR LOGIC ---
                
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