import time
import os
import json
import datetime
from selenium import webdriver
from selenium.webdriver.chrome.service import Service
from selenium.webdriver.common.by import By
from selenium.webdriver.support.ui import WebDriverWait
from selenium.webdriver.support import expected_conditions as EC
from selenium.common.exceptions import TimeoutException, NoSuchElementException
from selenium.webdriver.common.action_chains import ActionChains

# Import new libraries for OCR/GUI automation
import cv2
import numpy as np
import pytesseract
import pyautogui
from PIL import Image

# --- Tesseract-OCR path configuration ---
# IMPORTANT: Adjust this path to your Tesseract installation
# pytesseract.pytesseract.tesseract_cmd = r'C:\Program Files\Tesseract-OCR\tesseract.exe'

# --- Configuration for Testing ---
home_dir = os.path.expanduser("~")
SELENIUM_DATA_ROOT = os.path.join(home_dir, "selenium_whatsapp_test_data")
if not os.path.exists(SELENIUM_DATA_ROOT):
    os.makedirs(SELENIUM_DATA_ROOT)

USER_DATA_DIR = os.path.join(SELENIUM_DATA_ROOT, "session")
DOWNLOADS_DIR = os.path.join(SELENIUM_DATA_ROOT, "downloads")

WHATSAPP_URL = 'https://web.whatsapp.com/'

# --- XPATHS to test ---
LOGGED_IN_MARKER_XPATH = "//div[@id='side']//div[@aria-label='Search input textbox']"
TARGET_CHAT_XPATH = "//span[@title='Work Phone NESTLE']"
LAST_MESSAGE_CONTAINER_XPATH = "(//div[contains(@class, 'message-in')])[last()]"
AUDIO_PLAYER_IN_MSG_XPATH = ".//button[@aria-label='Play voice message']"

# XPATH for the menu button (down arrow/context menu)
# Used only to target for ActionChains.
AUDIO_MESSAGE_MENU_BUTTON_XPATH = "//div[@role='button' and @aria-label='Context menu']"


# --- Network logs list (kept for general troubleshooting) ---
NETWORK_LOGS = []

def setup_driver():
    """Sets up the Chrome driver for testing with CDP enabled."""
    options = webdriver.ChromeOptions()
    # Keep headless OFF for visual automation! PyAutoGUI needs a visible screen.
    # options.add_argument("--headless=new")
    options.add_argument("--no-sandbox")
    options.add_argument("--disable-gpu")
    options.add_argument("--window-size=1920,1080") # IMPORTANT: Fixed window size for image rec
    options.add_argument("--disable-extensions")
    options.add_argument(f"user-data-dir={USER_DATA_DIR}")

    if not os.path.exists(DOWNLOADS_DIR):
        os.makedirs(DOWNLOADS_DIR)
    print(f"[Setup] Configured Chrome to download files to: {DOWNLOADS_DIR}")

    prefs = {
        "download.default_directory": os.path.abspath(DOWNLOADS_DIR),
        "download.prompt_for_download": False,
        "download.directory_upgrade": True,
        "safebrowsing.enabled": True
    }
    options.add_experimental_option("prefs", prefs)

    options.add_argument("--remote-debugging-port=9222")

    service = Service()
    driver = webdriver.Chrome(service=service, options=options)

    driver.execute_cdp_cmd("Network.enable", {})
    driver.execute_cdp_cmd("Network.clearBrowserCache", {})
    driver.execute_cdp_cmd("Network.clearBrowserCookies", {})

    return driver

def save_page_source_and_screenshot(driver, filename_prefix):
    """Saves the current page source and a screenshot."""
    timestamp = datetime.datetime.now().strftime("%Y%m%d_%H%M%S")
    html_filename = os.path.join(SELENIUM_DATA_ROOT, f"{filename_prefix}_{timestamp}.html")
    screenshot_filename = os.path.join(SELENIUM_DATA_ROOT, f"{filename_prefix}_{timestamp}.png")
    try:
        with open(html_filename, "w", encoding="utf-8") as f:
            f.write(driver.page_source)
        print(f"   -> Page source saved to: '{html_filename}'")
    except Exception as e:
        print(f"   -> Failed to save page source: {e}")
    try:
        driver.save_screenshot(screenshot_filename)
        print(f"   -> Screenshot saved to: '{screenshot_filename}'")
    except Exception as e:
        print(f"   -> Failed to save screenshot: {e}")
    return screenshot_filename # Return the path to the saved screenshot

def get_network_resource_entries(driver):
    """Retrieves and filters network resource entries."""
    entries = driver.execute_script("return window.performance.getEntriesByType('resource');")
    
    download_requests = []
    for entry in entries:
        url = entry.get('name', '')
        if "mmg.whatsapp.net/d/f/" in url or url.startswith("blob:https://web.whatsapp.com/"):
            download_requests.append({
                "url": url,
                "method": "GET",
                "transferSize": entry.get('transferSize'),
                "duration": entry.get('duration'),
                "initiatorType": entry.get('initiatorType'),
                "responseStatus": entry.get('responseStatus'),
            })
    return download_requests

def find_and_click_download_button_with_ocr(screenshot_path):
    """
    Attempts to find the 'Download' button on the screenshot using OCR
    and then clicks its center using PyAutoGUI.
    """
    print(f"[OCR] Processing screenshot: {screenshot_path}")
    try:
        # Load the image with OpenCV
        img_cv = cv2.imread(screenshot_path)
        if img_cv is None:
            print("[OCR ERROR] Could not load screenshot image.")
            return False

        # Convert to PIL Image for pytesseract
        img_pil = Image.fromarray(cv2.cvtColor(img_cv, cv2.COLOR_BGR2RGB))

        # Use pytesseract to get data, including bounding boxes
        # output_type=Output.DICT gives a dictionary with 'text', 'left', 'top', 'width', 'height'
        data = pytesseract.image_to_data(img_pil, output_type=pytesseract.Output.DICT)

        download_found = False
        target_center_x = -1
        target_center_y = -1

        # Iterate through detected words/lines
        for i in range(len(data['text'])):
            text = data['text'][i].strip()
            # Basic check for "Download" (case-insensitive, could be "download" or "DOWNLOAD")
            if "download" in text.lower() and float(data['conf'][i]) > 70: # Confidence threshold
                x = data['left'][i]
                y = data['top'][i]
                w = data['width'][i]
                h = data['height'][i]

                # Calculate the center of the detected text
                target_center_x = x + w // 2
                target_center_y = y + h // 2
                download_found = True
                print(f"[OCR] Found 'Download' at screen coordinates: ({target_center_x}, {target_center_y})")
                break # Found it, no need to search further

        if download_found:
            # PyAutoGUI click
            # IMPORTANT: PyAutoGUI clicks on absolute screen coordinates.
            # Ensure the browser window is in the foreground and not moved.
            print(f"[PYAUTOGUI] Moving mouse to ({target_center_x}, {target_center_y}) and clicking.")
            pyautogui.moveTo(target_center_x, target_center_y, duration=0.2)
            pyautogui.click()
            print("[PYAUTOGUI] Click action performed.")
            return True
        else:
            print("[OCR] 'Download' text not found in screenshot or confidence too low.")
            return False

    except Exception as e:
        print(f"[OCR ERROR] An error occurred during OCR processing or clicking: {e}")
        return False


def test_download_audio():
    driver = setup_driver()
    try:
        print("--- Starting WhatsApp Web Test Script ---")
        driver.get(WHATSAPP_URL)
        print("1. Loading WhatsApp Web. Waiting for login or logged-in state...")

        WebDriverWait(driver, 90).until(
            EC.presence_of_element_located((By.XPATH, f"//div[@data-ref] | {LOGGED_IN_MARKER_XPATH}"))
        )

        try:
            driver.find_element(By.XPATH, LOGGED_IN_MARKER_XPATH) 
            print("   -> Logged in successfully!")
        except NoSuchElementException:
            print("   -> QR code detected. Please scan the QR code within the next 60 seconds.")
            WebDriverWait(driver, 60).until(
                EC.presence_of_element_located((By.XPATH, LOGGED_IN_MARKER_XPATH))
            )
            print("   -> Login complete!")

        time.sleep(3)

        print(f"2. Navigating to target chat with XPATH: '{TARGET_CHAT_XPATH}'")
        target_chat = WebDriverWait(driver, 15).until(
            EC.element_to_be_clickable((By.XPATH, TARGET_CHAT_XPATH))
        )
        target_chat.click()
        print("   -> Entered chat.")
        time.sleep(3)

        print(f"3. Finding the last message container with XPATH: '{LAST_MESSAGE_CONTAINER_XPATH}'")
        last_message_container = WebDriverWait(driver, 15).until(
            EC.presence_of_element_located((By.XPATH, LAST_MESSAGE_CONTAINER_XPATH))
        )
        print("   -> Last message container found.")
        
        print("   -> Debug: Saving state before checking if message is audio.")
        save_page_source_and_screenshot(driver, "before_audio_check")

        is_audio = False
        try:
            last_message_container.find_element(By.XPATH, AUDIO_PLAYER_IN_MSG_XPATH)
            is_audio = True
            print("   -> Confirmed: It's an audio message. Proceeding with download attempt via visual automation.")
        except NoSuchElementException:
            print("   -> WARNING: Last message is NOT an audio message. Please ensure the last message in the target chat is an INCOMING audio message.")
            return

        initial_files = set(os.listdir(DOWNLOADS_DIR))
        print(f"   -> Initial files in download dir: {initial_files}")

        print("4. Attempting to download audio message via visual automation...")
        
        # Step 4.1: Perform ActionChains hover to attempt to trigger the menu button visually
        actions = ActionChains(driver)
        print("   -> Action: Moving mouse to message container with ActionChains to attempt menu visibility.")
        actions.move_to_element(last_message_container).perform()
        time.sleep(1.5) # Give elements a moment to react

        # Step 4.2: Capture screenshot after hover
        screenshot_filename = save_page_source_and_screenshot(driver, "after_action_chains_mouseover_for_ocr")
        
        # Step 4.3: Attempt to find and click the context menu button using visual recognition (OCR for text)
        # This is the most complex and potentially brittle part.
        print(f"   -> Action: Attempting to find and click context menu button using OCR/PyAutoGUI on {screenshot_filename}.")
        
        # We need to find the "down arrow" or "three dots" to click it.
        # This is harder than finding text. Let's try to OCR for a common text in the context menu
        # (like "Star" or "Report") to confirm the menu is open, then click a relative position,
        # or directly OCR for "Download" if it's already there.

        # FIRST, let's try to make the menu *appear* more reliably.
        # We assume the ActionChains hover *did* put the menu button in the DOM, even if not visible.
        # So, we force its click via JS directly to try and open the menu.
        # This is a fallback from previous attempts where ActionChains failed to make it clickable.
        try:
            menu_button_element = WebDriverWait(driver, 5).until( # Short wait for presence after hover
                EC.presence_of_element_located((By.XPATH, AUDIO_MESSAGE_MENU_BUTTON_XPATH))
            )
            print("   -> Context menu button element found in DOM. Forcing visibility and clicking via JavaScript to open menu.")
            driver.execute_script("arguments[0].style.display = 'block'; arguments[0].style.opacity = '1'; arguments[0].click();", menu_button_element)
            time.sleep(2) # Give context menu time to render
            
            # NOW, take a screenshot with the menu open.
            screenshot_menu_open_filename = save_page_source_and_screenshot(driver, "menu_open_for_ocr")

            # Try to find and click "Download" in this new screenshot
            if find_and_click_download_button_with_ocr(screenshot_menu_open_filename):
                print("[SUCCESS] 'Download' button clicked via OCR/PyAutoGUI.")
            else:
                print("[ERROR] 'Download' button not found via OCR after opening menu.")
                raise Exception("OCR failed to find 'Download' button.")

        except TimeoutException:
            print("[ERROR] Context menu button not found in DOM after ActionChains hover.")
            print("        This indicates ActionChains is not triggering the necessary DOM changes for the menu to appear.")
            raise # Re-raise to go to the error handling block
        except Exception as e:
            print(f"[CRITICAL] An unexpected error during context menu handling: {e}")
            raise

        # Give a moment for the download to initiate
        time.sleep(2) 
        save_page_source_and_screenshot(driver, "after_download_clicked_via_ocr")

        # --- AFTER the download is triggered, try to capture network logs ---
        global NETWORK_LOGS
        NETWORK_LOGS = get_network_resource_entries(driver)

        # Step 4.4: Wait for the file to appear in the download directory
        timeout = 20
        start_time = time.time()
        downloaded_file_path = None

        print(f"5. Waiting for file to appear in '{DOWNLOADS_DIR}' (timeout: {timeout}s)")
        while time.time() - start_time < timeout:
            current_files = set(os.listdir(DOWNLOADS_DIR))
            new_files = current_files - initial_files
            if new_files:
                potential_files = [os.path.join(DOWNLOADS_DIR, f) for f in new_files if not f.endswith('.crdownload')]
                if potential_files:
                    downloaded_file_path = max(potential_files, key=os.path.getctime)
                    print(f"\n--- SUCCESS! Audio message downloaded to: {os.path.basename(downloaded_file_path)} ---")
                    return downloaded_file_path # Return path on success
            time.sleep(1)

        print("\n!!! ERROR: Audio download initiated, but file did not appear or complete within timeout. !!!")
        save_page_source_and_screenshot(driver, "download_failed_final")
        print("   -> Review the generated HTML and screenshot for clues.")
        return None # Return None on failure

    except TimeoutException as e:
        print(f"\n!!! Selenium Timeout Error: {e} !!!")
        print("   -> An element was not found within the expected time.")
        print("   -> Review the XPATHs and ensure the WhatsApp Web page is in the expected state.")
        save_page_source_and_screenshot(driver, "timeout_error_at_failure")
        print("   -> Current URL:", driver.current_url)
        print("   -> Page Title:", driver.title)
        return None
    except NoSuchElementException as e:
        print(f"\n!!! Selenium Element Not Found Error: {e} !!!")
        print("   -> An element with the specified XPATH was not found.")
        print("   -> Review the XPATHs carefully against the WhatsApp Web HTML structure.")
        save_page_source_and_screenshot(driver, "nosuch_error_at_failure")
        print("   -> Current URL:", driver.current_url)
        print("   -> Page Title:", driver.title)
        return None
    except Exception as e:
        print(f"\n!!! An unexpected error occurred: {e} !!!")
        save_page_source_and_screenshot(driver, "general_error_at_failure")
        print("   -> Current URL:", driver.current_url)
        print("   -> Page Title:", driver.title)
        return None
    finally:
        print("\n--- Test Script Finished. Closing browser in 10 seconds. ---")
        if NETWORK_LOGS:
            print("\n--- Captured Network Resources (post-download click) ---")
            for req in NETWORK_LOGS:
                print(f"  URL: {req.get('url')}")
                print(f"  Method: {req.get('method')}")
                print(f"  Transfer Size: {req.get('transferSize')} bytes")
                print(f"  Duration: {req.get('duration')} ms")
                print(f"  Initiator Type: {req.get('initiatorType')}")
                print(f"  Response Status: {req.get('responseStatus')}")
                print("-" * 30)
            print("\n")
        else:
            print("\n--- No relevant download requests found in network logs. ---")
        
        try:
            driver.execute_cdp_cmd("Network.disable", {})
        except Exception as e:
            print(f"[CDP] Error disabling Network logging: {e}")
        time.sleep(10)
        driver.quit()

if __name__ == "__main__":
    downloaded_file = test_download_audio()
    if downloaded_file:
        print(f"\nFinal Result: Audio file successfully downloaded to {downloaded_file}")
    else:
        print("\nFinal Result: Audio download failed.")