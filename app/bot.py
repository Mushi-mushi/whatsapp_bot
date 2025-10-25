import time
import json
from selenium import webdriver
from selenium.webdriver.chrome.service import Service
from selenium.webdriver.common.by import By
from selenium.webdriver.support.ui import WebDriverWait
from selenium.webdriver.support import expected_conditions as EC
from selenium.common.exceptions import TimeoutException, NoSuchElementException
from selenium.webdriver.common.keys import Keys
from selenium.webdriver.common.action_chains import ActionChains
from textblob import TextBlob
import datetime
from datetime import timedelta
import os

from shared_state import shared_bot_state
from command_handler import get_command_class
from analyzers import sentiment_analyzer
import logger
import insults_game

# --- Configuration & Selectors ---
CONFIG_PATH = 'config/config.json'
USER_DATA_DIR = 'user_data/session'
WHATSAPP_URL = 'https://web.whatsapp.com/'

QR_CODE_XPATH = "//div[@data-ref]"
LOGGED_IN_MARKER_XPATH = "//div[@id='side']//div[@aria-label='Search input textbox']"
UNREAD_CHAT_CONTAINER_XPATH = "//div[@role='row'][.//span[contains(@aria-label, ' unread message')]]"
SENDER_NAME_IN_LIST_XPATH = ".//span[@title]"
LAST_MESSAGE_CONTAINER_XPATH = "(//div[contains(@class, 'message-in')])[last()]"
AUDIO_PLAYER_IN_MSG_XPATH = ".//button[@aria-label='Play voice message']"
TEXT_IN_MSG_XPATH = ".//span[contains(@class, 'selectable-text')]"
MESSAGE_INPUT_BOX_XPATH = "//div[@id='main']//footer//div[@role='textbox']"

# UPDATED SELECTORS FOR AUDIO DOWNLOAD
AUDIO_MESSAGE_MENU_BUTTON_XPATH = ".//span[@data-testid='msg-context-menu-btn']"
AUDIO_DOWNLOAD_OPTION_XPATH = "//li[.//span[@data-testid='download-btn'] and .//div[text()='Download']]"


# Helper function to send messages reliably
def send_message_to_current_chat(driver, message_text):
    try:
        input_box = WebDriverWait(driver, 5).until(EC.element_to_be_clickable((By.XPATH, MESSAGE_INPUT_BOX_XPATH)))
        clean_reply_text = strip_non_bmp_chars(message_text)
        lines = clean_reply_text.split('\n')
        for i, line in enumerate(lines):
            if i > 0:
                ActionChains(driver).key_down(Keys.SHIFT).key_down(Keys.ENTER).key_up(Keys.SHIFT).key_up(Keys.ENTER).perform()
            input_box.send_keys(line)
        input_box.send_keys(Keys.ENTER)
        print(f"[SUCCESS] Sent reply.")
    except Exception as e:
        print(f"[ERROR] Failed to send reply: {e}")


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
            "audio_download_enabled": False, # Default to False
            "audio_download_dir": "/downloads/audio", # Default dir
            "dynamic_commands": {},
            "keyword_responses": {"hello": "Default response: Hello!"},
            "approved_senders": []
        }

def setup_driver():
    """Sets up the Chrome driver with download preferences."""
    options = webdriver.ChromeOptions()
    options.add_argument("--no-sandbox")
    options.add_argument("--headless=new")
    options.add_argument("--disable-gpu")
    options.add_argument("--window-size=1920,1080")
    options.add_argument("--disable-extensions")
    options.add_argument(f"user-data-dir={USER_DATA_DIR}")

    # Configure download directory for Chrome
    config = load_config() # Load config to get the desired download dir
    download_dir = config.get("audio_download_dir", "/downloads/audio")
    if not os.path.exists(download_dir):
        os.makedirs(download_dir)
    print(f"[DEBUG] Configured Chrome to download files to: {download_dir}")

    prefs = {
        "download.default_directory": download_dir,
        "download.prompt_for_download": False,  # Disable download prompt
        "download.directory_upgrade": True,
        "safebrowsing.enabled": True
    }
    options.add_experimental_option("prefs", prefs)

    service = Service()
    return webdriver.Chrome(service=service, options=options)


def get_static_keyword_reply(message_lower, config):
    """Handler for simple, static keyword replies."""
    return config.get('keyword_responses', {}).get(message_lower)

def strip_non_bmp_chars(text):
    """Removes characters outside the Basic Multilingual Plane (like emojis)."""
    return ''.join(c for c in text if ord(c) <= 0xFFFF) # Corrected to filter out surrogates too

def download_audio_message(driver, message_container, config):
    """
    Attempts to download an audio message by hovering over its container,
    clicking the revealed menu button, then selecting the download option.
    Returns the path of the downloaded file or None on failure.
    """
    download_dir = config.get("audio_download_dir", "/downloads/audio")
    if not os.path.exists(download_dir):
        os.makedirs(download_dir)

    initial_files = set(os.listdir(download_dir))

    try:
        # Step 1: Hover over the message container to reveal the menu button
        actions = ActionChains(driver)
        actions.move_to_element(message_container).perform()
        time.sleep(0.5) # Give elements a moment to become visible

        # Step 2: Click the menu button within the message container
        menu_button = WebDriverWait(message_container, 5).until(
            EC.element_to_be_clickable((By.XPATH, AUDIO_MESSAGE_MENU_BUTTON_XPATH))
        )
        print("[DEBUG] Found audio message menu button, attempting to click.")
        menu_button.click()
        time.sleep(1) # Small pause for context menu to render

        # Step 3: Find and click the 'Download' option in the opened context menu
        download_option = WebDriverWait(driver, 5).until(
            EC.element_to_be_clickable((By.XPATH, AUDIO_DOWNLOAD_OPTION_XPATH))
        )
        print("[DEBUG] Found 'Download' option in the context menu, attempting to click.")
        download_option.click()

        # Step 4: Wait for the file to appear in the download directory
        timeout = 15 # seconds to wait for download to start and complete
        start_time = time.time()
        downloaded_file_path = None

        while time.time() - start_time < timeout:
            current_files = set(os.listdir(download_dir))
            new_files = current_files - initial_files
            if new_files:
                potential_files = [os.path.join(download_dir, f) for f in new_files if not f.endswith('.crdownload')]
                if potential_files:
                    downloaded_file_path = max(potential_files, key=os.path.getctime)
                    print(f"[SUCCESS] Audio message downloaded to: {downloaded_file_path}")
                    return downloaded_file_path
            time.sleep(1) # Check every second

        print("[ERROR] Audio download initiated, but file did not appear or complete within timeout.")

    except TimeoutException:
        print("[ERROR] Could not find menu button or 'Download' option after clicking. XPATHs might need adjustment or elements were not visible/clickable.")
    except Exception as e:
        print(f"[CRITICAL] An unexpected error occurred during audio download: {e}")

    return None


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
                # --- SIESTA CHECK ---
                if shared_bot_state.siesta_until and datetime.datetime.now() < shared_bot_state.siesta_until:
                    siesta_remaining = shared_bot_state.siesta_until - datetime.datetime.now()
                    minutes = int(siesta_remaining.total_seconds() / 60)
                    seconds = int(siesta_remaining.total_seconds() % 60)
                    print(f"[DEBUG] Bot is currently on siesta. Remaining: {minutes}m {seconds}s.")
                    time.sleep(5)
                    continue # Skip the rest of the loop and re-check siesta status
                elif shared_bot_state.siesta_until and datetime.datetime.now() >= shared_bot_state.siesta_until:
                    print("[DEBUG] Siesta has ended. Waking up!")
                    shared_bot_state.siesta_until = None # Reset siesta state


                # --- TORTURE CHECK (HIGH PRIORITY) ---
                if shared_bot_state.torture_active:
                    now = datetime.datetime.now()
                    if not shared_bot_state.torture_messages_to_send:
                        print("[DEBUG] Torture completed: No more messages to send.")
                        shared_bot_state.torture_active = False
                        shared_bot_state.torture_target_sender = None
                        shared_bot_state.torture_start_time = None
                        shared_bot_state.torture_last_sent_time = None
                    elif (shared_bot_state.torture_last_sent_time is None or
                          (now - shared_bot_state.torture_last_sent_time).total_seconds() >= shared_bot_state.torture_message_interval):
                        try:
                            print(f"[DEBUG] Torture active: Ensuring bot is in chat with '{shared_bot_state.torture_target_sender}'.")
                            target_chat_element = WebDriverWait(driver, 10).until(
                                EC.element_to_be_clickable((By.XPATH, f"//span[@title='{shared_bot_state.torture_target_sender}']"))
                            )
                            target_chat_element.click()
                            time.sleep(2)
                        except TimeoutException:
                            print(f"[ERROR] Torture failed: Could not re-enter chat with '{shared_bot_state.torture_target_sender}'. Aborting torture.")
                            send_message_to_current_chat(driver, f"Torture session with {shared_bot_state.torture_target_sender} aborted. Could not re-enter chat.")
                            shared_bot_state.torture_active = False
                            shared_bot_state.torture_messages_to_send = []
                            shared_bot_state.torture_target_sender = None
                            time.sleep(2)
                            driver.refresh()
                            continue

                        message = shared_bot_state.torture_messages_to_send.pop(0)
                        print(f"[DEBUG] Sending torture message to {shared_bot_state.torture_target_sender}: '{message}'")
                        send_message_to_current_chat(driver, message)
                        shared_bot_state.torture_last_sent_time = now
                        time.sleep(1)
                    else:
                        print("[DEBUG] Torture active, but not time for next message yet.")
                        time.sleep(1)
                    
                    continue


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

                print(f"[DEBUG] Trying to find unread chats with XPATH: {UNREAD_CHAT_CONTAINER_XPATH}")
                unread_chat_containers = driver.find_elements(By.XPATH, UNREAD_CHAT_CONTAINER_XPATH)

                if unread_chat_containers:
                    print(f"[DEBUG] Found {len(unread_chat_containers)} unread chat(s).")
                    chat_container = unread_chat_containers[0]

                    try:
                        print(f"[DEBUG] Attempting to find sender name with XPATH: {SENDER_NAME_IN_LIST_XPATH} within chat container.")
                        sender_element = chat_container.find_element(By.XPATH, SENDER_NAME_IN_LIST_XPATH)
                        sender_name = sender_element.get_attribute("title").strip()
                        print(f"[DEBUG] Found unread message from: '{sender_name}'")

                        if sender_name in config.get('approved_senders', []):
                            print(f"[INFO] Sender '{sender_name}' is APPROVED. Processing...")
                            
                            # --- Handle Insult Game Input FIRST ---
                            if (shared_bot_state.insult_game_active and
                                shared_bot_state.insult_game_target_sender == sender_name and
                                shared_bot_state.insult_game_current_insult_index is not None):
                                
                                chat_container.click()
                                time.sleep(2)
                                last_message_container = WebDriverWait(driver, 10).until(
                                    EC.presence_of_element_located((By.XPATH, LAST_MESSAGE_CONTAINER_XPATH))
                                )
                                message_text_original = last_message_container.find_element(By.XPATH, TEXT_IN_MSG_XPATH).text.strip()
                                
                                print(f"[DEBUG] Insult game active, processing comeback: '{message_text_original}'")
                                reply_text = insults_game.check_comeback(message_text_original, shared_bot_state)
                                send_message_to_current_chat(driver, reply_text)
                                time.sleep(2)
                                driver.refresh()
                                continue

                            # Check for insult game timeout
                            if shared_bot_state.insult_game_active and shared_bot_state.insult_game_target_sender == sender_name:
                                if (datetime.datetime.now() - shared_bot_state.insult_game_last_interaction).total_seconds() > (60 * 5): # 5 min timeout
                                    reply_text = "It seems our duel has gone quiet. My wit is unmatched, so I'll assume victory by default! Game over. 🥱"
                                    reply_text += f"\n{insults_game.stop_game(shared_bot_state)}"
                                    chat_container.click()
                                    time.sleep(2)
                                    send_message_to_current_chat(driver, reply_text)
                                    time.sleep(2)
                                    driver.refresh()
                                    continue

                            # NORMAL MESSAGE PROCESSING
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
                                if config.get("audio_download_enabled"):
                                    print("[INFO] Audio download is enabled. Attempting to download...")
                                    downloaded_file = download_audio_message(driver, last_message_container, config)
                                    if downloaded_file:
                                        reply_text = f"Audio message from {sender_name} downloaded successfully to: {os.path.basename(downloaded_file)}. (Transcription not yet implemented)."
                                    else:
                                        reply_text = "WhatsApp Bot: Tried to download the audio message but encountered an issue. Is the menu button/download option XPATH correct or not visible?"
                                else:
                                    reply_text = "WhatsApp Bot: Audio messages are not enabled for download or transcription. Stop sending audio message."
                            else:
                                print("[DEBUG] Assuming text message.")
                                message_text_original = last_message_container.find_element(By.XPATH, TEXT_IN_MSG_XPATH).text.strip()
                                message_text_lower = message_text_original.lower()
                                print(f"[DEBUG] Read text: '{message_text_original}'")

                                CommandClass = get_command_class(message_text_original, config)
                                if CommandClass:
                                    command_instance = CommandClass()
                                    required_context = command_instance.get_required_context()
                                    context_data = {}
                                    if "sender_name" in required_context:
                                        context_data["sender_name"] = sender_name
                                    reply_text = command_instance.execute(config, message_text_original, context_data)
                                    
                                    if shared_bot_state.torture_active and shared_bot_state.torture_target_sender == sender_name:
                                        pass
                                    else:
                                        if reply_text:
                                            send_message_to_current_chat(driver, reply_text)
                                            time.sleep(2)
                                            driver.refresh()
                                        continue
                                        
                                elif message_text_original.lower().startswith("bot."):
                                    available_commands = sorted(config.get("dynamic_commands", {}).keys())
                                    if available_commands:
                                        commands_list = "\n".join([f"- {cmd}" for cmd in available_commands])
                                        reply_text = f"Hmm, I don't quite understand that 'bot.' command. Perhaps you meant one of these?\n\n{commands_list}"
                                    else:
                                        reply_text = "I'm a simple bot. I don't have any specific commands configured yet!"

                                if reply_text is None:
                                    reply_text = sentiment_analyzer.analyze(message_text_original)
                                    if reply_text:
                                        blob = TextBlob(message_text_original)
                                        polarity = blob.sentiment.polarity
                                        sentiment = "Positive" if polarity > 0.1 else "Negative" if polarity < -0.1 else "Neutral"
                                        logger.log_sentiment(sender_name, sentiment, polarity, message_text_original)

                                if reply_text is None:
                                    reply_text = get_static_keyword_reply(message_text_lower, config)

                            if reply_text:
                                print(f"[DEBUG] Preparing to send reply:\n{reply_text}")
                                send_message_to_current_chat(driver, reply_text)
                            else:
                                print("[DEBUG] No matching logic found for this message.")

                            time.sleep(2)
                            print("[DEBUG] Refreshing page to continue...")
                            driver.refresh()

                        else:
                            print(f"[INFO] Sender '{sender_name}' is NOT approved. Ignoring.")
                            print("[DEBUG] Sender not approved, skipping processing.")
                            driver.refresh()

                    except NoSuchElementException as e:
                        print(f"[ERROR] Could not find an element while processing chat. Maybe the page structure changed or an element disappeared. Error: {e}")
                        print("[DEBUG] Skipping current chat and refreshing page to recover.")
                        driver.refresh()
                    except Exception as e:
                        print(f"[ERROR] An unexpected error occurred while processing a chat item: {e}. Refreshing.")
                        driver.refresh()
                else:
                    print("[DEBUG] No unread chats found.")

                print("[DEBUG] Waiting for next cycle...")
                time.sleep(5)

            # --- START: MODIFIED EXCEPTION HANDLING FOR RESILIENCE ---
            except (NoSuchElementException, TimeoutException):
                print("[WARNING] Could not find the logged-in marker or another key element. This can happen during page reloads.")
                print("[INFO] Attempting to recover by refreshing the page and continuing the loop.")
                try:
                    driver.refresh()
                    time.sleep(5)  # Give the page time to load after refresh
                except Exception as refresh_err:
                    print(f"[CRITICAL] Failed to refresh the driver: {refresh_err}. This may be a fatal error. Shutting down.")
                    shared_bot_state.status = "CRASHED"
                    break # Break only if refreshing itself fails
                continue # IMPORTANT: Continue to the next loop iteration to try again
            
            except Exception as e:
                print(f"[CRITICAL] An unexpected error occurred in the main loop: {e}")
                driver.save_screenshot("critical_error_screenshot.png")
                print("[INFO] Attempting to recover by refreshing the page after a critical error.")
                try:
                    driver.refresh()
                    time.sleep(10)
                except Exception as refresh_err:
                    print(f"[CRITICAL] Failed to refresh the driver after error: {refresh_err}. Shutting down.")
                    shared_bot_state.status = "CRASHED"
                    break # Break if recovery fails
                continue # IMPORTANT: Try to continue the loop
            # --- END: MODIFIED EXCEPTION HANDLING ---

    except Exception as e:
        print(f"A critical error occurred during bot startup or an unrecoverable crash: {e}")
        shared_bot_state.status = "CRASHED"

    finally:
        print("Bot is shutting down.")
        driver.quit()