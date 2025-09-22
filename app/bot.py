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

# --- ROBUST XPATH SELECTORS (Final Version) ---
QR_CODE_XPATH = "//div[@data-ref]"
LOGGED_IN_MARKER_XPATH = "//div[@id='side']//div[@aria-label='Search input textbox']"
UNREAD_CHAT_XPATH = "//span[contains(@aria-label, 'unread message')]/ancestor::div[@role='listitem']"
LAST_MESSAGE_TEXT_XPATH = "(//div[contains(@class, 'message-in')]//span[contains(@class, 'selectable-text')])[last()]"
MESSAGE_INPUT_BOX_XPATH = "//div[@id='main']//footer//div[@role='textbox']"


def load_config():
    """Loads config from file."""
    try:
        with open(CONFIG_PATH, 'r') as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        print("WARNING: config.json not found or invalid. Using default config.")
        return {
            "openai_api_key": "PASTE_YOUR_OPENAI_API_KEY_HERE",
            "transcription_enabled": True,
            "keyword_responses": {"hello": "Default response: Hello!"}
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
    """Main function to run the WhatsApp bot."""
    print("Starting bot...")
    shared_bot_state.status = "STARTING"
    driver = setup_driver()

    try:
        # --- Login Logic ---
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
                    print("[DEBUG] Bot is no longer in a logged-in state. Stopping.")
                    break

                # Reload config every 60 seconds
                current_time = time.time()
                if current_time - last_config_check_time > 60:
                    print("[DEBUG] Reloading configuration...")
                    config = load_config()
                    last_config_check_time = current_time

                # Find and process unread chats
                unread_chats = driver.find_elements(By.XPATH, UNREAD_CHAT_XPATH)
                
                if unread_chats:
                    print(f"[DEBUG] Found {len(unread_chats)} unread chat(s).")
                    chat_to_process = unread_chats[0]
                    try:
                        chat_to_process.click()
                        time.sleep(2)
                        
                        last_message_element = WebDriverWait(driver, 10).until(
                            EC.presence_of_element_located((By.XPATH, LAST_MESSAGE_TEXT_XPATH))
                        )
                        message_text = last_message_element.text.lower().strip()
                        
                        print(f"[DEBUG] Read message: '{message_text}'")
                        
                        keyword_responses = config.get('keyword_responses', {})
                        if message_text in keyword_responses:
                            reply_text = keyword_responses[message_text]
                            print(f"[DEBUG] Preparing to send reply: '{reply_text}'")
                            
                            input_box = WebDriverWait(driver, 10).until(
                                EC.element_to_be_clickable((By.XPATH, MESSAGE_INPUT_BOX_XPATH))
                            )
                            input_box.send_keys(reply_text + Keys.ENTER)
                            print(f"[SUCCESS] Sent reply: '{reply_text}'")
                            
                            # --- START: THE CRITICAL FIX ---
                            # Add a pause to allow WhatsApp to send the message before we refresh.
                            time.sleep(2) 
                            # --- END: THE CRITICAL FIX ---
                            
                            print("[DEBUG] Refreshing page to reset focus...")
                            driver.refresh()
                            time.sleep(5) 
                        else:
                            print("[DEBUG] Keyword not found in dictionary. No action taken.")
                        
                    except Exception as e:
                        print(f"[ERROR] An error occurred while processing chat: {e}")
                
                print("[DEBUG] Waiting for next cycle...")
                time.sleep(5)

            except (NoSuchElementException, TimeoutException):
                print("[ERROR] Could not find the logged-in marker. Assuming logged out. Waiting to reconnect...")
                shared_bot_state.status = "CRASHED"
                time.sleep(15)
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