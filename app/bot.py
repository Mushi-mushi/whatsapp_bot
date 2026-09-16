import time
import json
from selenium import webdriver
from selenium.webdriver.chrome.service import Service
from selenium.webdriver.common.by import By
from selenium.webdriver.support.ui import WebDriverWait
from selenium.webdriver.support import expected_conditions as EC
from selenium.common.exceptions import TimeoutException, NoSuchElementException, ElementClickInterceptedException, StaleElementReferenceException
from selenium.webdriver.common.keys import Keys
from selenium.webdriver.common.action_chains import ActionChains
from textblob import TextBlob
import requests
import datetime
from datetime import timedelta
import os
import re
import unicodedata
import hashlib

from shared_state import shared_bot_state
from command_handler import get_command_class
from analyzers import sentiment_analyzer
import logger
import insults_game

# --- Configuration & Selectors ---
CONFIG_PATH = 'config/config.json'
USER_DATA_DIR = 'user_data/session'
SEEN_STATE_PATH = 'logs/processed_message_ids.json'
KNOWN_CHATS_PATH = 'logs/known_chats.json'
WHATSAPP_URL = 'https://web.whatsapp.com/'

# Header prepended to every bot reply so it's clearly attributable to the bot.
# Non-BMP emoji get stripped on send (ChromeDriver limitation), so the bold text carries the signal.
# Keep the emoji OUTSIDE the bold markers so '*WhatsApp Bot:*' still renders bold after stripping.
DEFAULT_BOT_REPLY_PREFIX = "🤖 *WhatsApp Bot:*"
BOT_REPLY_PREFIX = DEFAULT_BOT_REPLY_PREFIX

QR_CODE_XPATH = "//div[@data-ref]"

# Avoid language-dependent labels. We classify login state from multiple UI signals.
QR_SIGNAL_XPATHS = [
    "//div[@data-ref]",
    "//div[contains(@data-testid, 'qrcode')]",
    "//canvas",
]

LOGGED_IN_SIGNAL_XPATHS = [
    "//div[@id='pane-side']",
    "//div[@id='main']",
    "//div[@id='main']//footer//div[@role='textbox']",
    "//div[@id='side']",
]

# Keep this selector for message flow compatibility, but do not use it as the only auth signal.
LOGGED_IN_MARKER_XPATH = "//div[@id='main']//footer//div[@role='textbox']"
UNREAD_CHAT_CONTAINER_XPATH = "//div[@role='row'][.//span[contains(@aria-label, ' unread message')]]"
SENDER_NAME_IN_LIST_XPATH = ".//span[@title]"
LAST_MESSAGE_CONTAINER_XPATH = "(//div[contains(@class, 'message-in')])[last()]"
LAST_ANY_MESSAGE_CONTAINER_XPATH = "(//div[(contains(@class, 'message-in') or contains(@class, 'message-out')) and .//span[contains(@class, 'selectable-text') or @dir='auto']])[last()]"
LAST_TESTID_MESSAGE_CONTAINER_XPATH = "(//div[@id='main']//div[@data-testid='msg-container'])[last()]"
LAST_GENERIC_TEXT_CONTAINER_XPATH = "(//div[@id='main']//div[.//span[contains(@class, 'selectable-text') or @dir='auto']])[last()]"
CHAT_HEADER_TITLE_XPATH = "//header//*[ @title ]"
ACTIVE_CHAT_TITLE_XPATHS = [
    "//header//*[@data-testid='conversation-info-header-chat-title']",
    "//header//span[@title]",
    "//header//div[@role='button']//span[@dir='auto']",
]
AUDIO_PLAYER_IN_MSG_XPATH = ".//button[@aria-label='Play voice message']"
ALT_AUDIO_PLAYER_XPATHS = [
    ".//button[@aria-label='Play voice message']",
    ".//*[@data-icon='audio-play']",
    ".//*[@data-testid='audio-play']",
    ".//*[@data-testid='ptt-play']",
]
GLOBAL_AUDIO_PLAYER_XPATH = (
    "//div[@id='main']//*["
    "@data-testid='audio-play' or "
    "@data-testid='ptt-play' or "
    "@data-icon='audio-play' or "
    "@aria-label='Play voice message'"
    "]"
)
TEXT_IN_MSG_XPATH = ".//span[contains(@class, 'selectable-text') or @dir='auto']"
MESSAGE_INPUT_BOX_XPATH = "//div[@id='main']//footer//div[@role='textbox']"
IMAGE_OR_MEDIA_IN_MSG_XPATHS = [
    ".//*[@data-testid='image-thumb']",
    ".//*[@data-testid='video-thumb']",
    ".//*[@data-testid='media-play']",
    ".//*[@data-testid='sticker']",
    ".//*[@data-icon='video']",
    ".//*[@data-icon='image']",
    ".//img",
]

# UPDATED SELECTORS FOR AUDIO DOWNLOAD
AUDIO_MESSAGE_MENU_BUTTON_XPATHS = [
    ".//*[@data-testid='msg-context-menu-btn']",
    ".//*[@data-testid='down-context']",
    ".//*[@data-icon='down-context']",
    ".//*[@aria-label='Context menu']",
]
AUDIO_DOWNLOAD_OPTION_XPATHS = [
    "//li[.//*[@data-testid='download-btn']]",
    "//div[@role='button'][.//*[@data-testid='download-btn']]",
    "//*[@role='menuitem'][.//*[@data-testid='download-btn'] or .//*[@data-icon='download']]",
    "//li[.//*[@data-icon='download']]",
    "//div[@role='button'][.//*[@data-icon='download']]",
    "//*[@role='menuitem'][contains(translate(normalize-space(.), 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'), 'download')]",
    "//*[@role='menuitem'][contains(@aria-label, 'Download') or contains(@aria-label, 'download')]",
]
MESSAGE_REPLY_OPTION_XPATHS = [
    "//li[.//*[@data-icon='reply']]",
    "//div[@role='button'][.//*[@data-icon='reply']]",
    "//*[@role='menuitem'][.//*[@data-icon='reply']]",
    "//*[@role='menuitem'][contains(@aria-label, 'Reply') or contains(@aria-label, 'reply')]",
    "//*[@role='menuitem'][contains(translate(normalize-space(.), 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'), 'reply')]",
    "//*[@aria-label='Reply']",
]


# Helper function to send messages reliably
def apply_bot_reply_prefix(message_text):
    """Prepends the bot signature header so replies are clearly from the bot."""
    text = str(message_text or "")
    prefix = (BOT_REPLY_PREFIX or "").strip()
    if not prefix:
        return text
    # Avoid double-prefixing and match against the emoji-stripped form we actually send.
    stripped_prefix = strip_non_bmp_chars(prefix).strip()
    if text.startswith(prefix) or (stripped_prefix and text.startswith(stripped_prefix)):
        return text
    return f"{prefix}\n{text}"


def send_message_to_current_chat(driver, message_text):
    try:
        input_box = WebDriverWait(driver, 5).until(EC.element_to_be_clickable((By.XPATH, MESSAGE_INPUT_BOX_XPATH)))
        clean_reply_text = strip_non_bmp_chars(apply_bot_reply_prefix(message_text))
        lines = clean_reply_text.split('\n')
        for i, line in enumerate(lines):
            if i > 0:
                ActionChains(driver).key_down(Keys.SHIFT).key_down(Keys.ENTER).key_up(Keys.SHIFT).key_up(Keys.ENTER).perform()
            input_box.send_keys(line)
        input_box.send_keys(Keys.ENTER)
        print(f"[SUCCESS] Sent reply.")
    except Exception as e:
        print(f"[ERROR] Failed to send reply: {e}")


def safe_click(driver, element, label="element", retries=3):
    """Clicks an element with scroll/action/js fallbacks for intercepted clicks."""
    last_error = None

    for attempt in range(1, retries + 1):
        try:
            driver.execute_script("arguments[0].scrollIntoView({block: 'center', inline: 'nearest'});", element)
            time.sleep(0.15)
            element.click()
            return True
        except ElementClickInterceptedException as e:
            last_error = e
            print(f"[WARNING] Click intercepted on {label} (attempt {attempt}/{retries}). Trying fallback...")
            try:
                ActionChains(driver).move_to_element(element).pause(0.1).click(element).perform()
                return True
            except Exception:
                try:
                    driver.execute_script("arguments[0].click();", element)
                    return True
                except Exception as js_err:
                    last_error = js_err
                    time.sleep(0.3)
        except Exception as e:
            last_error = e
            time.sleep(0.2)

    print(f"[ERROR] Failed to click {label} after {retries} attempts: {last_error}")
    return False


def get_last_message_container(driver):
    """Return the latest message container using multiple selector families."""
    candidates = [
        LAST_MESSAGE_CONTAINER_XPATH,
        LAST_ANY_MESSAGE_CONTAINER_XPATH,
        LAST_TESTID_MESSAGE_CONTAINER_XPATH,
        LAST_GENERIC_TEXT_CONTAINER_XPATH,
    ]

    for idx, xpath in enumerate(candidates, start=1):
        try:
            element = WebDriverWait(driver, 4).until(
                EC.presence_of_element_located((By.XPATH, xpath))
            )
            if idx > 1:
                print(f"[DEBUG] Last-message selector used fallback {idx}/{len(candidates)}.")
            return element
        except TimeoutException:
            pass

    raise TimeoutException("Could not locate any message container in active chat.")


def get_latest_actionable_incoming_message(driver, sender_name, prefer_audio=False, lookback=8):
    """
    Scans incoming messages from newest to oldest and returns the latest actionable payload.
    Actionable means either an audio message or non-empty text content that is not just sender-label noise.
    """
    incoming_containers = driver.find_elements(By.XPATH, "//div[contains(@class, 'message-in')]")
    if lookback and lookback > 0:
        incoming_containers = incoming_containers[-lookback:]
    sender_norm = normalize_sender_name(sender_name)

    # In multi-unread scenarios, prefer the newest recent audio message first.
    if prefer_audio:
        for container in reversed(incoming_containers):
            if has_any_xpath(container, ALT_AUDIO_PLAYER_XPATHS):
                print("[DEBUG] Selected latest actionable incoming message: audio (audio-priority mode)")
                return {
                    "is_audio": True,
                    "text": None,
                    "container": container,
                }

    for container in reversed(incoming_containers):
        if has_any_xpath(container, ALT_AUDIO_PLAYER_XPATHS):
            print("[DEBUG] Selected latest actionable incoming message: audio")
            return {
                "is_audio": True,
                "text": None,
                "container": container,
            }

        text_nodes = container.find_elements(By.XPATH, TEXT_IN_MSG_XPATH)
        lines = []
        for node in text_nodes:
            text = node.text.strip()
            if text:
                lines.append(text)

        if not lines:
            continue

        message_text = "\n".join(lines).strip()
        if not message_text:
            continue

        # Some fallback selectors can hit sender labels in group metadata; skip those.
        if normalize_sender_name(message_text) == sender_norm:
            continue

        print("[DEBUG] Selected latest actionable incoming message: text")
        return {
            "is_audio": False,
            "text": message_text,
            "container": container,
        }

    return None


def extract_author_from_pre_plain(pre_plain):
    """Extracts author name from WhatsApp pre-plain header like '[..] Name: '."""
    text = str(pre_plain or "")
    match = re.search(r"\]\s*(.*?):\s*$", text)
    if match:
        return match.group(1).strip()
    return ""


def is_likely_outgoing_author(author_name):
    """Best-effort outgoing author check across common locales."""
    author_norm = normalize_sender_name(author_name)
    return author_norm in {
        "you",
        "me",
        "yo",
        "vous",
        "vouz",
        "você",
        "voce",
        "ich",
        "io",
    }


def get_incoming_message_containers(driver, lookback=20):
    """Returns likely incoming message containers in DOM order (oldest -> newest)."""
    incoming = []
    # Primary path used on many WhatsApp builds.
    primary = driver.find_elements(By.XPATH, "//div[contains(@class, 'message-in')]")
    if primary:
        incoming = primary
    else:
        # Fallback path for DOMs where direction is inside msg-container descendants.
        msg_containers = driver.find_elements(By.XPATH, "//div[@id='main']//div[@data-testid='msg-container']")
        for container in msg_containers:
            try:
                classes = (container.get_attribute("class") or "").lower()
                if "message-out" in classes:
                    continue
                if "message-in" in classes:
                    incoming.append(container)
                    continue

                has_in = bool(container.find_elements(By.XPATH, ".//*[contains(@class, 'message-in')]"))
                has_out = bool(container.find_elements(By.XPATH, ".//*[contains(@class, 'message-out')]"))
                if has_in and not has_out:
                    incoming.append(container)
                    continue
                if has_out and not has_in:
                    continue

                # Last fallback: infer from pre-plain author label when direction classes are missing.
                pre_plain = container.get_attribute("data-pre-plain-text") or ""
                author = extract_author_from_pre_plain(pre_plain)
                if author and is_likely_outgoing_author(author):
                    continue

                # Keep ambiguous containers so queue diagnostics can still surface them.
                incoming.append(container)
            except Exception:
                continue

    if lookback and lookback > 0:
        incoming = incoming[-lookback:]
    return incoming


def classify_incoming_message(container, sender_norm=None):
    """Classifies one incoming message bubble and returns structured metadata."""
    kind = "unknown"
    text_lines = []
    text = None
    sender_label_only = False

    has_audio = has_any_xpath(container, ALT_AUDIO_PLAYER_XPATHS)
    has_media = has_any_xpath(container, IMAGE_OR_MEDIA_IN_MSG_XPATHS)

    try:
        text_nodes = container.find_elements(By.XPATH, TEXT_IN_MSG_XPATH)
        for node in text_nodes:
            node_text = (node.text or "").strip()
            if node_text:
                text_lines.append(node_text)
    except Exception:
        text_lines = []

    data_id, pre_plain = get_message_identity(container)
    source_hint = data_id

    author_name = extract_author_from_pre_plain(pre_plain)
    author_norm = normalize_sender_name(author_name) if author_name else ""

    if text_lines:
        text = "\n".join(text_lines).strip()
        text = re.sub(r"\s+\d{1,2}:\d{2}\s*$", "", text).strip()
        if text and sender_norm and normalize_sender_name(text) == sender_norm:
            sender_label_only = True
        if text and author_norm and normalize_sender_name(text) == author_norm:
            sender_label_only = True
        if looks_like_sender_stamp_only(text):
            sender_label_only = True

    if text and text.startswith("Transcription of the last message:"):
        # Ignore bot self-replies when they appear in fallback container scans.
        sender_label_only = True

    # data-id starting with 3EB0 marks a message sent from THIS account (incl. all bot
    # replies). Never treat our own outgoing messages as actionable, or the bot loops on
    # its own text (e.g. an insults reply that literally contains 'bot.insults').
    is_own_outgoing = bool(data_id and data_id.upper().startswith("3EB0"))
    if is_own_outgoing:
        sender_label_only = True

    if has_audio:
        kind = "audio"
    elif text and not sender_label_only:
        kind = "text"
    elif has_media:
        kind = "media"

    if is_own_outgoing:
        kind = "outgoing"

    is_actionable = kind in ("audio", "text", "media")
    return {
        "kind": kind,
        "text": text,
        "has_audio": has_audio,
        "has_media": has_media,
        "sender_label_only": sender_label_only,
        "is_actionable": is_actionable,
        "author": author_name,
        "data_id": data_id,
        "pre_plain": pre_plain,
        "source_hint": source_hint,
        "container": container,
    }


def enumerate_incoming_message_candidates(driver, sender_name=None, lookback=20):
    """Builds ordered incoming-message candidates (oldest -> newest) for queue processing."""
    incoming_containers = get_incoming_message_containers(driver, lookback=lookback)

    sender_norm = normalize_sender_name(sender_name) if sender_name else None
    candidates = []
    for idx, container in enumerate(incoming_containers):
        meta = classify_incoming_message(container, sender_norm=sender_norm)
        meta["index"] = idx
        meta["signature"] = build_message_signature(
            container,
            is_audio=(meta["kind"] == "audio"),
            text=meta.get("text"),
            message_kind=meta["kind"],
        )
        candidates.append(meta)

    return candidates


def extract_bot_command_text(message_text):
    """Extract bot command from mixed group labels, e.g. 'Name Bot.status 14:02'."""
    text = re.sub(r"\s+", " ", str(message_text or "")).strip()
    if not text:
        return None

    text = re.sub(r"\s+\d{1,2}:\d{2}\s*$", "", text)
    # Allow dotted subcommands like 'bot.roast.neg' (each dot must precede a word char).
    match = re.search(r"(?i)\bbot\.[a-z0-9_-]+(?:\.[a-z0-9_-]+)*(?:\s+.*)?$", text)
    if not match:
        return None
    return match.group(0).strip()


def looks_like_sender_stamp_only(text):
    """Heuristic to detect text rows that are only sender labels plus optional timestamp."""
    value = re.sub(r"\s+\d{1,2}:\d{2}\s*$", "", str(text or "")).strip()
    if not value:
        return True
    tokens = value.split()
    if len(tokens) < 2 or len(tokens) > 5:
        return False
    if any(ch in value for ch in ".!?:;"):
        return False

    alpha_tokens = [tok for tok in tokens if any(c.isalpha() for c in tok)]
    if not alpha_tokens:
        return False
    return all(tok[0].isupper() for tok in alpha_tokens if tok)


def choose_bootstrap_candidate(unseen_items):
    """Choose first bootstrap item, prioritizing newest audio, then newest explicit bot command."""
    if not unseen_items:
        return None

    audio_items = [item for item in unseen_items if item.get("kind") == "audio"]
    if audio_items:
        return audio_items[-1]

    command_items = [
        item for item in unseen_items
        if item.get("kind") == "text" and extract_bot_command_text(item.get("text"))
    ]
    if command_items:
        return command_items[-1]

    return unseen_items[-1]


def extract_message_minute(item):
    """Extracts an 'HH:MM' minute tag from a candidate's pre-plain header or trailing text time."""
    pre = item.get("pre_plain") or ""
    match = re.search(r"\[(\d{1,2}:\d{2})", pre)
    if match:
        return match.group(1)
    text = item.get("text") or ""
    match = re.search(r"(\d{1,2}:\d{2})\s*$", text)
    if match:
        return match.group(1)
    return None


def select_first_contact_group(unseen_actionable):
    """On first contact, target the newest same-minute burst so a live burst isn't dropped.

    Returns (item_to_process_now, set_of_group_signatures). Items outside the group are
    treated as pre-existing history and should be marked seen by the caller.
    """
    if not unseen_actionable:
        return None, set()

    newest_minute = extract_message_minute(unseen_actionable[-1])
    if newest_minute is None:
        chosen = choose_bootstrap_candidate(unseen_actionable)
        return chosen, {chosen.get("signature")} if chosen else set()

    group = [item for item in unseen_actionable if extract_message_minute(item) == newest_minute]
    if not group:
        chosen = choose_bootstrap_candidate(unseen_actionable)
        return chosen, {chosen.get("signature")} if chosen else set()

    return group[0], {item.get("signature") for item in group}


def parse_message_datetime(item):
    """Parses a datetime from a candidate's pre-plain header like '[14:15, 9/12/2026]'."""
    pre = item.get("pre_plain") or ""
    match = re.search(r"\[(\d{1,2}):(\d{2}),\s*(\d{1,2})/(\d{1,2})/(\d{4})\]", pre)
    if not match:
        return None
    hh, mm, month, day, year = (int(g) for g in match.groups())
    try:
        return datetime.datetime(year, month, day, hh, mm)
    except ValueError:
        return None


def compute_recent_signatures(candidates, window_minutes=20):
    """Returns the set of signatures within a recent time window of the newest message.

    Audio messages carry no timestamp, so they inherit the time of their nearest
    neighbor (preferring the following message). Returns None if no timestamps exist.
    """
    raw = [parse_message_datetime(c) for c in candidates]
    n = len(candidates)
    effective = list(raw)

    following = None
    for i in range(n - 1, -1, -1):
        if raw[i] is not None:
            following = raw[i]
        elif effective[i] is None:
            effective[i] = following

    preceding = None
    for i in range(n):
        if raw[i] is not None:
            preceding = raw[i]
        elif effective[i] is None:
            effective[i] = preceding

    known = [d for d in effective if d is not None]
    if not known:
        return None

    cutoff = max(known) - datetime.timedelta(minutes=window_minutes)
    recent = set()
    for candidate, dt in zip(candidates, effective):
        if dt is not None and dt >= cutoff:
            sig = candidate.get("signature")
            if sig:
                recent.add(sig)
    return recent


def debug_dump_candidates(candidates, sender_name, tag="unread", max_items=20):
    """Logs a compact candidate dump to inspect queue behavior under burst traffic."""
    if not candidates:
        print(f"[QUEUE] [{tag}] sender='{sender_name}' candidates=0")
        return

    print(f"[QUEUE] [{tag}] sender='{sender_name}' candidates={len(candidates)} (oldest->newest)")
    start = max(0, len(candidates) - max_items)
    for idx, item in enumerate(candidates[start:], start=start):
        preview = (item.get("text") or "").replace("\n", " ")
        if len(preview) > 60:
            preview = preview[:57] + "..."
        sig = item.get("signature", "")[:10]
        data_id = item.get("data_id", "")
        has_id = "yes" if data_id else "no"
        print(
            "[QUEUE] "
            f"i={idx} kind={item.get('kind')} actionable={item.get('is_actionable')} "
            f"sender_label_only={item.get('sender_label_only')} has_audio={item.get('has_audio')} "
            f"has_media={item.get('has_media')} author='{item.get('author', '')}' sig={sig} "
            f"has_id={has_id} data_id='{data_id[:48]}' pre='{item.get('pre_plain', '')}' text='{preview}'"
        )


def log_message_dom_probe(driver, tag="probe"):
    """Prints DOM counters/samples when queue enumeration unexpectedly returns zero."""
    try:
        msg_container_count = len(driver.find_elements(By.XPATH, "//div[@id='main']//div[@data-testid='msg-container']"))
    except Exception:
        msg_container_count = 0
    try:
        in_count = len(driver.find_elements(By.XPATH, "//div[contains(@class, 'message-in')]"))
    except Exception:
        in_count = 0
    try:
        out_count = len(driver.find_elements(By.XPATH, "//div[contains(@class, 'message-out')]"))
    except Exception:
        out_count = 0
    try:
        audio_count = len(driver.find_elements(By.XPATH, GLOBAL_AUDIO_PLAYER_XPATH))
    except Exception:
        audio_count = 0

    try:
        data_id_count = len(driver.find_elements(By.XPATH, "//div[@id='main']//*[@data-id]"))
    except Exception:
        data_id_count = 0

    print(
        f"[QUEUE-PROBE] tag={tag} msg_containers={msg_container_count} "
        f"message_in={in_count} message_out={out_count} audio_controls={audio_count} "
        f"data_id_nodes={data_id_count}"
    )

    try:
        sample = driver.find_elements(By.XPATH, "//div[@id='main']//*[@data-id]")[-5:]
        for idx, container in enumerate(sample):
            data_id = (container.get_attribute("data-id") or "").strip()
            pre = ""
            try:
                pre_nodes = container.find_elements(By.XPATH, ".//*[@data-pre-plain-text][1]")
                if pre_nodes:
                    pre = (pre_nodes[0].get_attribute("data-pre-plain-text") or "").strip()
            except Exception:
                pre = ""
            txt = ""
            try:
                txt_nodes = container.find_elements(By.XPATH, TEXT_IN_MSG_XPATH)
                lines = [(node.text or "").strip() for node in txt_nodes if (node.text or "").strip()]
                txt = " | ".join(lines)
            except Exception:
                txt = ""
            if len(txt) > 80:
                txt = txt[:77] + "..."
            print(f"[QUEUE-PROBE] sample={idx} data_id='{data_id[:60]}' pre='{pre}' text='{txt}'")
    except Exception:
        pass


def get_latest_audio_message_container_global(driver):
    """Find the newest visible audio play control in the active chat and return its message container."""
    controls = driver.find_elements(By.XPATH, GLOBAL_AUDIO_PLAYER_XPATH)
    for control in reversed(controls):
        try:
            if not control.is_displayed():
                continue
            container = None
            ancestors = control.find_elements(By.XPATH, "./ancestor::*[@data-testid='msg-container'][1]")
            if ancestors:
                container = ancestors[0]
            else:
                # Fallback to class-based message bubble ancestry.
                bubble = control.find_elements(By.XPATH, "./ancestor::*[contains(@class, 'message-in') or contains(@class, 'message-out')][1]")
                if bubble:
                    container = bubble[0]
            if container is not None:
                print("[DEBUG] Selected latest audio message from global audio control scan.")
                return container
        except Exception:
            continue
    return None


def get_recent_audio_message_containers_global(driver, limit=10):
    """Returns recent visible audio message containers in DOM order (oldest -> newest)."""
    controls = driver.find_elements(By.XPATH, GLOBAL_AUDIO_PLAYER_XPATH)
    containers = []
    seen = set()

    for control in controls:
        try:
            if not control.is_displayed():
                continue
            container = None
            ancestors = control.find_elements(By.XPATH, "./ancestor::*[@data-testid='msg-container'][1]")
            if ancestors:
                container = ancestors[0]
            else:
                bubble = control.find_elements(By.XPATH, "./ancestor::*[contains(@class, 'message-in') or contains(@class, 'message-out')][1]")
                if bubble:
                    container = bubble[0]
            if container is None:
                continue

            sig = build_message_signature(container, is_audio=True, text=None)
            if sig in seen:
                continue
            seen.add(sig)
            containers.append(container)
        except Exception:
            continue

    if limit and limit > 0:
        containers = containers[-limit:]
    return containers


def has_any_xpath(context, xpaths):
    """True if any xpath in list matches at least one element in the provided context."""
    for xpath in xpaths:
        try:
            if context.find_elements(By.XPATH, xpath):
                return True
        except Exception:
            continue
    return False


def wait_for_clickable_from_xpaths(context, xpaths, timeout_seconds=5):
    """Returns first displayed+enabled element matching any xpath in context, waiting until timeout."""
    deadline = time.time() + timeout_seconds
    while time.time() < deadline:
        for xpath in xpaths:
            try:
                candidates = context.find_elements(By.XPATH, xpath)
                for element in candidates:
                    if element.is_displayed() and element.is_enabled():
                        return element
            except Exception:
                continue
        time.sleep(0.2)
    raise TimeoutException(f"Could not find clickable element for xpaths: {xpaths}")


def get_actionable_message_container(message_container):
    """Find a stable message ancestor: prefer msg-container testid, then any element with data-id."""
    for xpath in (
        "./ancestor-or-self::*[@data-testid='msg-container'][1]",
        "./ancestor-or-self::*[@data-id][1]",
    ):
        try:
            ancestors = message_container.find_elements(By.XPATH, xpath)
            if ancestors:
                return ancestors[0]
        except Exception:
            continue
    return message_container


def get_message_identity(container):
    """Extract WhatsApp's stable per-message identity: (data_id, pre_plain).

    data-id lives on an ancestor row element; data-pre-plain-text on the copyable-text descendant.
    Both are absent on older msg-container-only builds, so we search broadly.
    """
    data_id = ""
    pre_plain = ""

    for xpath in (
        "./ancestor-or-self::*[@data-id][1]",
        ".//*[@data-id][1]",
    ):
        try:
            found = container.find_elements(By.XPATH, xpath)
            if found:
                data_id = (found[0].get_attribute("data-id") or "").strip()
                if data_id:
                    break
        except Exception:
            continue

    for xpath in (
        "./ancestor-or-self::*[@data-pre-plain-text][1]",
        ".//*[@data-pre-plain-text][1]",
    ):
        try:
            found = container.find_elements(By.XPATH, xpath)
            if found:
                pre_plain = (found[0].get_attribute("data-pre-plain-text") or "").strip()
                if pre_plain:
                    break
        except Exception:
            continue

    return data_id, pre_plain


def get_message_container_by_data_id(driver, data_id):
    """Re-locate a specific message container by its stable data-id (for stale recovery)."""
    if not data_id:
        return None
    try:
        safe_id = data_id.replace('"', '')
        nodes = driver.find_elements(By.XPATH, f"//div[@id='main']//*[@data-id=\"{safe_id}\"]")
        for node in nodes:
            try:
                if node.is_displayed():
                    return node
            except Exception:
                continue
        if nodes:
            return nodes[0]
    except Exception:
        pass
    return None


def open_audio_context_menu(driver, message_container, target_data_id=None):
    """Open message context menu using button click first, then right-click fallback.

    When target_data_id is provided, stale recovery re-finds that exact message
    instead of falling back to the newest audio, avoiding acting on the wrong one.
    """
    current_container = message_container

    def _refetch():
        by_id = get_message_container_by_data_id(driver, target_data_id) if target_data_id else None
        return by_id or get_latest_audio_message_container_global(driver)

    for attempt in range(1, 4):
        try:
            target = get_actionable_message_container(current_container)
            # Touch a property to force stale-element failure early if detached.
            _ = target.tag_name

            # Strategy 1: hover target and click the dedicated context-menu button.
            try:
                ActionChains(driver).move_to_element(target).perform()
                time.sleep(0.4)
                menu_button = wait_for_clickable_from_xpaths(target, AUDIO_MESSAGE_MENU_BUTTON_XPATHS, timeout_seconds=3)
                print("[DEBUG] Found audio message menu button, attempting to click.")
                if safe_click(driver, menu_button, label="audio message menu button"):
                    return True
            except Exception:
                pass

            # Strategy 1b: force-click hidden menu button with JavaScript (often present but not interactable).
            for xpath in AUDIO_MESSAGE_MENU_BUTTON_XPATHS:
                try:
                    buttons = target.find_elements(By.XPATH, xpath)
                    if not buttons:
                        continue
                    menu_button = buttons[0]
                    driver.execute_script(
                        "arguments[0].style.display='block'; arguments[0].style.visibility='visible'; "
                        "arguments[0].style.opacity='1'; arguments[0].click();",
                        menu_button,
                    )
                    print("[DEBUG] Opened message context menu via JS-forced menu button click.")
                    time.sleep(0.4)
                    return True
                except Exception:
                    continue

            # Strategy 2: open native context menu by right-clicking the message.
            try:
                ActionChains(driver).move_to_element(target).pause(0.15).context_click(target).perform()
                print("[DEBUG] Opened message context menu via right-click fallback.")
                time.sleep(0.4)
                return True
            except Exception as e:
                print(f"[WARNING] Failed to open audio context menu via right-click fallback: {e}")

        except StaleElementReferenceException:
            print(f"[WARNING] Audio container became stale (attempt {attempt}/3). Refetching target audio container.")
            refreshed = _refetch()
            if refreshed is None:
                return False
            current_container = refreshed
            time.sleep(0.2)
            continue

        # Refetch on generic failure as well, because WhatsApp chat DOM mutates quickly.
        refreshed = _refetch()
        if refreshed is None:
            return False
        current_container = refreshed
        time.sleep(0.2)

    return False


def find_download_option(driver):
    """Finds a clickable download option from an opened message context menu."""
    try:
        return wait_for_clickable_from_xpaths(driver, AUDIO_DOWNLOAD_OPTION_XPATHS, timeout_seconds=6)
    except TimeoutException:
        # Debug current visible menu items to quickly adapt selectors when WA changes.
        try:
            menu_items = driver.find_elements(By.XPATH, "//*[@role='menuitem']")
            snippets = []
            for item in menu_items[:8]:
                label = (item.text or "").strip().replace("\n", " ")
                aria = item.get_attribute("aria-label")
                testid = item.get_attribute("data-testid")
                snippets.append(f"text='{label}' aria='{aria}' testid='{testid}'")
            if snippets:
                print("[DEBUG] Visible menuitems snapshot: " + " | ".join(snippets))
        except Exception:
            pass
        raise


def find_reply_option(driver):
    """Finds a clickable 'Reply' option from an opened message context menu."""
    try:
        return wait_for_clickable_from_xpaths(driver, MESSAGE_REPLY_OPTION_XPATHS, timeout_seconds=5)
    except TimeoutException:
        try:
            menu_items = driver.find_elements(By.XPATH, "//*[@role='menuitem']")
            snippets = []
            for item in menu_items[:8]:
                label = (item.text or "").strip().replace("\n", " ")
                aria = item.get_attribute("aria-label")
                snippets.append(f"text='{label}' aria='{aria}'")
            if snippets:
                print("[DEBUG] Visible menuitems snapshot (reply): " + " | ".join(snippets))
        except Exception:
            pass
        raise


def reply_to_message(driver, message_container, message_text, target_data_id=None):
    """Sends message_text as a WhatsApp reply quoting the given message. Returns True on success."""
    if not open_audio_context_menu(driver, message_container, target_data_id=target_data_id):
        return False
    try:
        reply_option = find_reply_option(driver)
    except TimeoutException:
        try:
            ActionChains(driver).send_keys(Keys.ESCAPE).perform()
        except Exception:
            pass
        return False

    if not safe_click(driver, reply_option, label="reply option"):
        return False
    time.sleep(0.4)
    send_message_to_current_chat(driver, message_text)
    return True


def send_reply(driver, message_text, quote_container=None, quote_data_id=None):
    """Sends a reply, quoting the referenced message when a target is provided, else a plain message."""
    if quote_container is not None or quote_data_id is not None:
        if reply_to_message(driver, quote_container, message_text, target_data_id=quote_data_id):
            return
        print("[WARNING] Could not quote-reply to the target message; sending as a normal message.")
    send_message_to_current_chat(driver, message_text)


def debug_dump_sidebar_titles(driver, approved_senders):
    """Logs exact sidebar chat titles (repr + codepoints) to verify approved-sender spelling."""
    try:
        elements = driver.find_elements(By.XPATH, "//div[@id='pane-side']//span[@title]")
    except Exception as e:
        print(f"[TITLES] Could not read sidebar titles: {e}")
        return

    approved_norms = {normalize_sender_name(s): s for s in approved_senders if str(s).strip()}
    seen_titles = set()
    print(f"[TITLES] Scanning {len(elements)} sidebar title span(s) to verify approved-sender spelling.")

    for el in elements:
        try:
            title = el.get_attribute("title") or ""
        except Exception:
            continue
        if not title or title in seen_titles:
            continue
        seen_titles.add(title)

        norm = normalize_sender_name(title)
        matched = approved_norms.get(norm)
        has_non_ascii = any(ord(c) > 127 for c in title)
        if matched or has_non_ascii:
            codepoints = " ".join(f"U+{ord(c):04X}" for c in title)
            flag = f" <== MATCHES approved '{matched}'" if matched else ""
            print(f"[TITLES] title={title!r} norm={norm!r} codepoints=[{codepoints}]{flag}")
        else:
            print(f"[TITLES] title={title!r} norm={norm!r}")

    found_norms = {normalize_sender_name(t) for t in seen_titles}
    for norm, original in approved_norms.items():
        if norm not in found_norms:
            print(f"[TITLES] Approved sender NOT visible in current sidebar: {original!r} (norm={norm!r})")


def write_known_chats(driver, max_chats=500):
    """Writes currently-visible sidebar chat titles to disk (merged) for the dashboard picker."""
    try:
        elements = driver.find_elements(By.XPATH, "//div[@id='pane-side']//span[@title]")
    except Exception:
        return

    # Message previews in the sidebar are wrapped in bidirectional isolates / contain newlines;
    # real chat names are not, so we filter those out.
    bidi_marks = ("\u202a", "\u202b", "\u202c", "\u2066", "\u2067", "\u2068", "\u2069")

    new_titles = set()
    for el in elements:
        try:
            title = (el.get_attribute("title") or "").strip()
        except Exception:
            continue
        if not title or "\n" in title:
            continue
        if any(mark in title for mark in bidi_marks):
            continue
        new_titles.add(title)

    if not new_titles:
        return

    existing = []
    try:
        with open(KNOWN_CHATS_PATH, "r") as f:
            data = json.load(f)
        if isinstance(data, dict) and isinstance(data.get("chats"), list):
            existing = [str(t) for t in data["chats"]]
    except (FileNotFoundError, json.JSONDecodeError, OSError):
        existing = []

    def _is_clean(title):
        return bool(title) and "\n" not in title and not any(mark in title for mark in bidi_marks)

    existing = [t for t in existing if _is_clean(t)]
    merged = list(dict.fromkeys(existing + sorted(new_titles, key=lambda s: s.casefold())))
    merged.sort(key=lambda s: s.casefold())
    if len(merged) > max_chats:
        merged = merged[:max_chats]

    try:
        os.makedirs(os.path.dirname(KNOWN_CHATS_PATH) or ".", exist_ok=True)
        tmp_path = KNOWN_CHATS_PATH + ".tmp"
        with open(tmp_path, "w") as f:
            json.dump({"chats": merged, "updated_at": time.time()}, f)
        os.replace(tmp_path, KNOWN_CHATS_PATH)
    except OSError as e:
        print(f"[WARNING] Could not write known chats: {e}")


def open_chat_from_sidebar(driver, sender_element, chat_container, sender_name):
    """Opens chat; prefer sender-header match, otherwise accept a ready main chat panel."""
    click_plan = [
        (sender_element, f"chat title '{sender_name}'"),
        (chat_container, "unread chat row"),
    ]
    sender_norm = normalize_sender_name(sender_name)

    for idx, (element, label) in enumerate(click_plan):
        if not safe_click(driver, element, label=label):
            continue

        # Strong check: chat header exposes the expected sender name.
        try:
            WebDriverWait(driver, 6).until(
                EC.presence_of_element_located((
                    By.XPATH,
                    f"{CHAT_HEADER_TITLE_XPATH}[@title=\"{sender_name}\"] | "
                    f"//header//*[normalize-space(text())=\"{sender_name}\"]"
                ))
            )
            return True
        except TimeoutException:
            print(f"[WARNING] Clicked {label} but strict header match for '{sender_name}' was not found.")

        # Soft check: active header title matches after normalization.
        try:
            active_title = get_active_chat_title(driver)
            if normalize_sender_name(active_title) == sender_norm:
                print("[INFO] Active chat title matches expected sender after normalization.")
                return True
        except Exception:
            pass

        # If this was not the final click strategy, try the next one before accepting panel-ready fallback.
        if idx < len(click_plan) - 1:
            print("[DEBUG] Trying next chat-open fallback strategy.")
            continue

        # Fallback: if message input is interactable, we can proceed.
        try:
            WebDriverWait(driver, 5).until(
                EC.element_to_be_clickable((By.XPATH, MESSAGE_INPUT_BOX_XPATH))
            )
            print("[INFO] Chat panel is ready; proceeding without strict header-name match.")
            return True
        except TimeoutException:
            print(f"[WARNING] Chat panel not ready after clicking {label}.")

    return False


def get_active_chat_title(driver):
    """Best-effort extraction of currently open chat title from the main header."""
    for xpath in ACTIVE_CHAT_TITLE_XPATHS:
        try:
            elements = driver.find_elements(By.XPATH, xpath)
            for el in elements:
                if not el.is_displayed():
                    continue
                title = (el.get_attribute("title") or el.text or "").strip()
                if title:
                    return title
        except Exception:
            continue
    return None


def load_config():
    """Loads config from file, creating a default one if it's missing or invalid."""
    default_config = {
        "openai_api_key": "PASTE_YOUR_OPENAI_API_KEY_HERE",
        "transcription_enabled": True,
        "transcription_provider": "auralis",
        "auralis_base_url": "http://host.docker.internal:8000",
        "transcription_timeout_seconds": 90,
        "audio_download_enabled": False,
        "audio_download_dir": "/downloads/audio",
        "message_enumeration_debug": True,
        "bot_reply_prefix": DEFAULT_BOT_REPLY_PREFIX,
        "dynamic_commands": {},
        "keyword_responses": {"hello": "Default response: Hello!"},
        "approved_senders": []
    }

    try:
        with open(CONFIG_PATH, 'r') as f:
            raw = json.load(f)

        if not isinstance(raw, dict):
            return default_config

        config = dict(default_config)
        config.update(raw)

        # Normalize types for critical runtime fields.
        config["transcription_enabled"] = bool(config.get("transcription_enabled", False))
        config["audio_download_enabled"] = bool(config.get("audio_download_enabled", False))
        config["message_enumeration_debug"] = bool(config.get("message_enumeration_debug", True))
        config["bot_reply_prefix"] = str(config.get("bot_reply_prefix", DEFAULT_BOT_REPLY_PREFIX))
        config["transcription_provider"] = str(config.get("transcription_provider", "auralis")).strip() or "auralis"
        config["auralis_base_url"] = str(config.get("auralis_base_url", "http://host.docker.internal:8000")).strip()
        try:
            config["transcription_timeout_seconds"] = int(config.get("transcription_timeout_seconds", 90))
        except (TypeError, ValueError):
            config["transcription_timeout_seconds"] = 90
        if config["transcription_timeout_seconds"] < 5:
            config["transcription_timeout_seconds"] = 5

        if not isinstance(config.get("dynamic_commands"), dict):
            config["dynamic_commands"] = {}
        if not isinstance(config.get("keyword_responses"), dict):
            config["keyword_responses"] = {}
        if not isinstance(config.get("approved_senders"), list):
            config["approved_senders"] = []

        return config
    except (FileNotFoundError, json.JSONDecodeError):
        print("WARNING: config.json not found or invalid. Using default config.")
        return default_config


def transcribe_audio_with_auralis(audio_path, config):
    """Send a downloaded audio file to Auralis /transcribe and return transcript text or None."""
    base_url = str(config.get("auralis_base_url", "http://host.docker.internal:8000")).rstrip("/")
    endpoint = f"{base_url}/transcribe"
    timeout_seconds = int(config.get("transcription_timeout_seconds", 90))

    if not os.path.exists(audio_path):
        print(f"[ERROR] Transcription skipped: audio file not found at {audio_path}")
        return None

    try:
        with open(audio_path, "rb") as audio_file:
            files = {
                "file": (os.path.basename(audio_path), audio_file, "audio/ogg")
            }
            response = requests.post(endpoint, files=files, timeout=timeout_seconds)

        if response.status_code not in (200, 207):
            print(f"[ERROR] Auralis returned HTTP {response.status_code}: {response.text[:300]}")
            return None

        payload = response.json()
        # Auralis typically returns a list of per-file results.
        if isinstance(payload, list):
            for item in payload:
                if isinstance(item, dict) and item.get("status") == "ok":
                    transcript = str(item.get("transcript", "")).strip()
                    if transcript:
                        return transcript
            print(f"[WARNING] Auralis response had no successful transcript item: {payload}")
            return None

        # Fallback shape support.
        if isinstance(payload, dict):
            transcript = str(payload.get("transcript", "")).strip()
            if transcript:
                return transcript

        print(f"[WARNING] Unexpected Auralis response shape: {payload}")
        return None
    except requests.RequestException as req_err:
        print(f"[ERROR] Auralis request failed: {req_err}")
        return None
    except ValueError as json_err:
        print(f"[ERROR] Auralis returned non-JSON response: {json_err}")
        return None
    except Exception as e:
        print(f"[CRITICAL] Unexpected transcription error: {e}")
        return None


def build_audio_reply(driver, sender_name, last_message_container, config, target_data_id=None):
    """Handles download and optional transcription for an audio message."""
    if not config.get("audio_download_enabled"):
        return "WhatsApp Bot: Audio messages are not enabled for download or transcription. Stop sending audio message."

    print("[INFO] Audio download is enabled. Attempting to download...")
    downloaded_file = download_audio_message(driver, last_message_container, config, target_data_id=target_data_id)
    if not downloaded_file:
        return "WhatsApp Bot: Tried to download the audio message but encountered an issue. Is the menu button/download option XPATH correct or not visible?"

    if config.get("transcription_enabled") and str(config.get("transcription_provider", "")).lower() == "auralis":
        print("[INFO] Transcription is enabled (provider=auralis). Sending audio for transcription...")
        transcript = transcribe_audio_with_auralis(downloaded_file, config)
        if transcript:
            clean_transcript = transcript.strip()
            quoted_transcript = "\n".join(
                [f"> {line}" if line.strip() else ">" for line in clean_transcript.splitlines()]
            )
            return f"Transcription of the last message:\n{quoted_transcript}"

        return (
            f"Audio message downloaded successfully to: {os.path.basename(downloaded_file)}. "
            f"I could not get a transcription from Auralis right now."
        )

    return (
        f"Audio message from {sender_name} downloaded successfully to: "
        f"{os.path.basename(downloaded_file)}."
    )


def build_message_signature(container, is_audio=False, text=None, message_kind=None):
    """Builds a signature to avoid reprocessing the same message.

    Prefers WhatsApp's stable data-id (globally unique per message). Falls back to
    pre-plain header, then aria-label/innerHTML only when no stable id is available.
    """
    data_id, pre_plain = get_message_identity(container)

    if data_id:
        # data-id is stable and unique; it alone fully identifies the message.
        raw = f"id={data_id}"
    else:
        source = pre_plain
        if not source:
            try:
                actionable = get_actionable_message_container(container)
                source = actionable.get_attribute("aria-label") or actionable.get_attribute("innerHTML") or ""
            except Exception:
                source = ""
        raw = f"kind={message_kind or ''}|audio={is_audio}|text={text or ''}|src={source[:600]}"

    return hashlib.sha1(raw.encode("utf-8", errors="ignore")).hexdigest()


def has_seen_signature(signature_map, sender_norm, signature):
    """Checks whether a sender signature was already processed."""
    entry = signature_map.get(sender_norm)
    if not entry:
        return False
    return signature in entry["set"]


def mark_seen_signature(signature_map, sender_norm, signature, max_per_sender=2000):
    """Stores processed signatures with a bounded, O(1)-lookup history per sender.

    Bound is far larger than the visible DOM window so a stable data-id is never
    forgotten while still on screen, which previously caused reprocessing.
    """
    entry = signature_map.get(sender_norm)
    if entry is None:
        entry = {"order": [], "set": set()}
        signature_map[sender_norm] = entry
    if signature in entry["set"]:
        return
    entry["order"].append(signature)
    entry["set"].add(signature)
    if len(entry["order"]) > max_per_sender:
        dropped = entry["order"][:-max_per_sender]
        entry["order"] = entry["order"][-max_per_sender:]
        for sig in dropped:
            entry["set"].discard(sig)


def mark_seen_signatures_from_candidates(signature_map, sender_norm, candidates, max_per_sender=2000):
    """Bulk-mark candidate signatures as seen, preserving bounded history."""
    for item in candidates:
        signature = item.get("signature")
        if signature:
            mark_seen_signature(signature_map, sender_norm, signature, max_per_sender=max_per_sender)


def load_seen_state():
    """Loads persisted per-sender processed-signature history from disk."""
    try:
        with open(SEEN_STATE_PATH, "r") as f:
            raw = json.load(f)
    except (FileNotFoundError, json.JSONDecodeError, OSError):
        return {}

    result = {}
    if isinstance(raw, dict):
        for sender, sigs in raw.items():
            if isinstance(sigs, list):
                order = [str(s) for s in sigs]
                result[sender] = {"order": order, "set": set(order)}
    return result


def save_seen_state(signature_map):
    """Atomically persists per-sender processed-signature history to disk."""
    try:
        serializable = {sender: entry.get("order", []) for sender, entry in signature_map.items()}
        os.makedirs(os.path.dirname(SEEN_STATE_PATH) or ".", exist_ok=True)
        tmp_path = SEEN_STATE_PATH + ".tmp"
        with open(tmp_path, "w") as f:
            json.dump(serializable, f)
        os.replace(tmp_path, SEEN_STATE_PATH)
    except OSError as e:
        print(f"[WARNING] Could not persist processed-message state: {e}")


def _get_visible_elements(driver, xpath):
    """Returns visible elements for an xpath without raising."""
    try:
        return [el for el in driver.find_elements(By.XPATH, xpath) if el.is_displayed()]
    except Exception:
        return []


def get_login_state(driver):
    """
    Returns (state, diagnostics) where state is one of:
    - LOGGED_IN
    - NEEDS_LOGIN
    - UNKNOWN
    """
    logged_in_hits = 0
    qr_hits = 0

    for xpath in LOGGED_IN_SIGNAL_XPATHS:
        if _get_visible_elements(driver, xpath):
            logged_in_hits += 1

    for xpath in QR_SIGNAL_XPATHS:
        if _get_visible_elements(driver, xpath):
            qr_hits += 1

    diagnostics = f"logged_in_hits={logged_in_hits}, qr_hits={qr_hits}"

    # Logged-in state must win when shell + main content is clearly present.
    if logged_in_hits >= 2:
        return "LOGGED_IN", diagnostics

    # If login shell is not established and QR-like artifacts are visible, login is required.
    if qr_hits >= 1 and logged_in_hits == 0:
        return "NEEDS_LOGIN", diagnostics

    return "UNKNOWN", diagnostics


def wait_for_login_state(driver, timeout_seconds=120):
    """Waits until login state becomes LOGGED_IN or NEEDS_LOGIN."""
    deadline = time.time() + timeout_seconds
    last_diag = ""

    while time.time() < deadline:
        state, diag = get_login_state(driver)
        last_diag = diag
        if state in ("LOGGED_IN", "NEEDS_LOGIN"):
            return state, diag
        time.sleep(2)

    raise TimeoutException(f"Could not resolve login state in {timeout_seconds}s. Last diagnostics: {last_diag}")


def get_qr_code_base64(driver):
    """Attempts to capture the currently visible QR area using fallback selectors."""
    for xpath in QR_SIGNAL_XPATHS:
        elements = _get_visible_elements(driver, xpath)
        if elements:
            return elements[0].screenshot_as_base64
    return None

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


def normalize_sender_name(name):
    """Canonical form for sender matching across emoji/quote/whitespace variants."""
    text = unicodedata.normalize("NFKC", str(name or ""))
    # Remove invisible joiners/variation selectors frequently present in emoji names.
    text = text.replace("\u200d", "").replace("\ufe0f", "")
    # Trim quote-like wrappers and normalize spaces.
    text = text.strip(" '\"`´’“”")
    text = re.sub(r"\s+", " ", text).strip()
    return text.casefold()

def strip_non_bmp_chars(text):
    """Removes characters outside the Basic Multilingual Plane (like emojis)."""
    return ''.join(c for c in text if ord(c) <= 0xFFFF) # Corrected to filter out surrogates too

def download_audio_message(driver, message_container, config, target_data_id=None):
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
        # Step 1: Open context menu with multiple strategies.
        if not open_audio_context_menu(driver, message_container, target_data_id=target_data_id):
            return None

        # Step 2: Find and click the download option in the opened context menu.
        download_option = find_download_option(driver)
        print("[DEBUG] Found 'Download' option in the context menu, attempting to click.")
        if not safe_click(driver, download_option, label="audio download option"):
            return None
        time.sleep(0.6)

        # Step 3: Wait for the file to appear in the download directory.
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
        try:
            ActionChains(driver).send_keys(Keys.ESCAPE).perform()
        except Exception:
            pass
    except Exception as e:
        print(f"[CRITICAL] An unexpected error occurred during audio download: {e}")
        try:
            ActionChains(driver).send_keys(Keys.ESCAPE).perform()
        except Exception:
            pass

    return None


def run_bot():
    """Main function to run the WhatsApp bot."""
    global BOT_REPLY_PREFIX
    print("Starting bot...")
    shared_bot_state.status = "STARTING"
    driver = setup_driver()

    try:
        # --- Login Logic ---
        driver.get(WHATSAPP_URL)
        print("Loading WhatsApp Web, please wait...")
        login_state, login_diag = wait_for_login_state(driver, timeout_seconds=120)
        print(f"Page loaded. Login diagnostics: {login_diag}")

        if login_state == "LOGGED_IN":
            shared_bot_state.status = "LOGGED_IN"
            print("Bot is logged in and running.")
        else:
            print("QR code found. Displaying on Web UI.")
            shared_bot_state.status = "NEEDS_LOGIN"
            while shared_bot_state.status == "NEEDS_LOGIN":
                state, diag = get_login_state(driver)
                if state == "LOGGED_IN":
                    shared_bot_state.status = "LOGGED_IN"
                    shared_bot_state.qr_code_base64 = None
                    print(f"Login successful! Bot is running. Diagnostics: {diag}")
                    break

                qr_b64 = get_qr_code_base64(driver)
                shared_bot_state.qr_code_base64 = qr_b64
                if qr_b64 is None:
                    print(f"[DEBUG] Waiting for QR render. Diagnostics: {diag}")
                time.sleep(1)

        # --- Main Bot Loop ---
        config = load_config()
        BOT_REPLY_PREFIX = config.get("bot_reply_prefix", DEFAULT_BOT_REPLY_PREFIX)
        last_config_check_time = time.time()
        # One-time diagnostic: print exact sidebar chat titles to verify approved-sender spelling.
        debug_dump_sidebar_titles(driver, config.get("approved_senders", []))
        # Seed the dashboard chat picker with currently-visible chats.
        write_known_chats(driver)
        last_known_chats_write = time.time()
        try:
            last_config_mtime = os.path.getmtime(CONFIG_PATH)
        except OSError:
            last_config_mtime = None
        last_processed_signature_by_sender = load_seen_state()
        last_known_approved_sender_name = None
        last_known_approved_sender_norm = None
        # Senders with persisted history are already past baseline, so no lossy bootstrap re-runs.
        sender_queue_bootstrapped = set(last_processed_signature_by_sender.keys())
        if sender_queue_bootstrapped:
            print(f"[QUEUE] Loaded processed-message memory for {len(sender_queue_bootstrapped)} sender(s) from disk.")
        previous_auth_state = "LOGGED_IN"
        idle_log_every_seconds = 30
        last_idle_log_time = 0.0

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
                            if not safe_click(driver, target_chat_element, label="torture target chat"):
                                raise TimeoutException("Could not click torture target chat")
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


                state, diag = get_login_state(driver)
                if state != previous_auth_state:
                    print(f"[AUTH] State transition: {previous_auth_state} -> {state} ({diag})")
                    previous_auth_state = state

                if state == "NEEDS_LOGIN":
                    if shared_bot_state.status != "NEEDS_LOGIN":
                        print(f"[WARNING] Session appears logged out. Diagnostics: {diag}")
                    shared_bot_state.status = "NEEDS_LOGIN"
                    shared_bot_state.qr_code_base64 = get_qr_code_base64(driver)
                    time.sleep(3)
                    continue
                if state == "LOGGED_IN" and shared_bot_state.status != "LOGGED_IN":
                    shared_bot_state.status = "LOGGED_IN"
                    shared_bot_state.qr_code_base64 = None
                    print(f"[INFO] Session restored without restart. Diagnostics: {diag}")

                current_time = time.time()
                should_reload_config = False
                try:
                    current_config_mtime = os.path.getmtime(CONFIG_PATH)
                    if last_config_mtime is None or current_config_mtime != last_config_mtime:
                        should_reload_config = True
                        last_config_mtime = current_config_mtime
                except OSError:
                    pass

                if current_time - last_config_check_time > 60:
                    should_reload_config = True

                if should_reload_config:
                    print("[DEBUG] Reloading configuration...")
                    config = load_config()
                    BOT_REPLY_PREFIX = config.get("bot_reply_prefix", DEFAULT_BOT_REPLY_PREFIX)
                    last_config_check_time = current_time

                approved_senders = config.get('approved_senders', [])
                approved_sender_lookup = {
                    normalize_sender_name(item): item for item in approved_senders if str(item).strip()
                }

                unread_chat_containers = driver.find_elements(By.XPATH, UNREAD_CHAT_CONTAINER_XPATH)

                # Find the first APPROVED unread chat so an unapproved chat's badge can't block us.
                approved_unread_container = None
                if unread_chat_containers:
                    print(f"[DEBUG] Found {len(unread_chat_containers)} unread chat(s).")
                    for candidate_container in unread_chat_containers:
                        try:
                            candidate_name = (candidate_container.find_element(By.XPATH, SENDER_NAME_IN_LIST_XPATH).get_attribute("title") or "").strip()
                        except Exception:
                            continue
                        if normalize_sender_name(candidate_name) in approved_sender_lookup:
                            approved_unread_container = candidate_container
                            break
                    if approved_unread_container is None:
                        print("[DEBUG] Unread chats present but none approved; checking active chat for pending items.")

                if approved_unread_container is not None:
                    chat_container = approved_unread_container

                    try:
                        print(f"[DEBUG] Attempting to find sender name with XPATH: {SENDER_NAME_IN_LIST_XPATH} within chat container.")
                        sender_element = chat_container.find_element(By.XPATH, SENDER_NAME_IN_LIST_XPATH)
                        sender_name = sender_element.get_attribute("title").strip()
                        print(f"[DEBUG] Found unread message from: '{sender_name}'")

                        sender_norm = normalize_sender_name(sender_name)

                        if sender_norm in approved_sender_lookup:
                            print(f"[INFO] Sender '{sender_name}' is APPROVED. Processing...")
                            last_known_approved_sender_name = sender_name
                            last_known_approved_sender_norm = sender_norm
                            
                            # --- Handle Insult Game Input FIRST ---
                            if (shared_bot_state.insult_game_active and
                                shared_bot_state.insult_game_target_sender == sender_name and
                                shared_bot_state.insult_game_current_insult_index is not None):
                                
                                if not open_chat_from_sidebar(driver, sender_element, chat_container, sender_name):
                                    raise TimeoutException(f"Could not open chat for '{sender_name}'")
                                time.sleep(2)
                                last_message_container = get_last_message_container(driver)
                                message_text_original = last_message_container.find_element(By.XPATH, TEXT_IN_MSG_XPATH).text.strip()
                                
                                print(f"[DEBUG] Insult game active, processing comeback: '{message_text_original}'")
                                reply_text = insults_game.check_comeback(message_text_original, shared_bot_state)
                                send_message_to_current_chat(driver, reply_text)
                                time.sleep(2)
                                continue

                            # Check for insult game timeout
                            if shared_bot_state.insult_game_active and shared_bot_state.insult_game_target_sender == sender_name:
                                if (datetime.datetime.now() - shared_bot_state.insult_game_last_interaction).total_seconds() > (60 * 5): # 5 min timeout
                                    reply_text = "It seems our duel has gone quiet. My wit is unmatched, so I'll assume victory by default! Game over. 🥱"
                                    reply_text += f"\n{insults_game.stop_game(shared_bot_state)}"
                                    if not open_chat_from_sidebar(driver, sender_element, chat_container, sender_name):
                                        raise TimeoutException(f"Could not open chat for '{sender_name}'")
                                    time.sleep(2)
                                    send_message_to_current_chat(driver, reply_text)
                                    time.sleep(2)
                                    continue

                            # NORMAL MESSAGE PROCESSING
                            if not open_chat_from_sidebar(driver, sender_element, chat_container, sender_name):
                                raise TimeoutException(f"Could not open chat for '{sender_name}'")
                            time.sleep(2)

                            payload = None
                            queue_candidates = enumerate_incoming_message_candidates(
                                driver,
                                sender_name=sender_name,
                                lookback=25,
                            )
                            if config.get("message_enumeration_debug", True):
                                debug_dump_candidates(queue_candidates, sender_name, tag="unread")
                                if not queue_candidates:
                                    log_message_dom_probe(driver, tag="unread-empty")

                            unseen_actionable = [
                                item for item in queue_candidates
                                if item.get("is_actionable")
                                and not has_seen_signature(last_processed_signature_by_sender, sender_norm, item["signature"])
                            ]

                            if unseen_actionable:
                                if sender_norm not in sender_queue_bootstrapped:
                                    # Recent time window keeps a live burst (incl. audio, which has
                                    # no timestamp) while skipping genuinely old history.
                                    recent_sigs = compute_recent_signatures(queue_candidates, window_minutes=20)
                                    if recent_sigs is None:
                                        chosen, recent_sigs = select_first_contact_group(unseen_actionable)
                                    else:
                                        recent_unseen = [it for it in unseen_actionable if it.get("signature") in recent_sigs]
                                        chosen = recent_unseen[0] if recent_unseen else None
                                    historical = [
                                        item for item in queue_candidates
                                        if item.get("signature") not in recent_sigs
                                    ]
                                    if historical:
                                        mark_seen_signatures_from_candidates(
                                            last_processed_signature_by_sender,
                                            sender_norm,
                                            historical,
                                        )
                                    sender_queue_bootstrapped.add(sender_norm)
                                    save_seen_state(last_processed_signature_by_sender)
                                    print("[QUEUE] First-contact baseline: recorded old history, processing recent burst window.")
                                else:
                                    chosen = unseen_actionable[0]

                                if chosen is not None:
                                    payload = {
                                        "is_audio": chosen["kind"] == "audio",
                                        "text": chosen.get("text"),
                                        "container": chosen["container"],
                                        "kind": chosen["kind"],
                                        "signature": chosen["signature"],
                                        "data_id": chosen.get("data_id"),
                                    }

                            if payload is None:
                                payload = get_latest_actionable_incoming_message(
                                    driver,
                                    sender_name,
                                    prefer_audio=False,
                                    lookback=8,
                                )
                            if payload is None:
                                # Keep old behavior as fallback if actionable scan misses.
                                last_message_container = get_last_message_container(driver)
                                is_audio = False
                                try:
                                    last_message_container.find_element(By.XPATH, AUDIO_PLAYER_IN_MSG_XPATH)
                                    is_audio = True
                                except NoSuchElementException:
                                    is_audio = has_any_xpath(last_message_container, ALT_AUDIO_PLAYER_XPATHS)
                                message_text_original = None
                            else:
                                last_message_container = payload["container"]
                                is_audio = payload["is_audio"]
                                message_text_original = payload["text"]
                            message_kind = payload.get("kind") if payload else ("audio" if is_audio else "text")
                            message_data_id = (payload or {}).get("data_id")
                            if not message_data_id:
                                message_data_id, _ = get_message_identity(last_message_container)

                            message_signature = build_message_signature(
                                last_message_container,
                                is_audio=is_audio,
                                text=message_text_original,
                                message_kind=message_kind,
                            )
                            if has_seen_signature(last_processed_signature_by_sender, sender_norm, message_signature):
                                print("[DEBUG] Latest message already processed for this sender. Skipping duplicate.")
                                time.sleep(2)
                                continue

                            reply_text = None

                            if is_audio:
                                print("[DEBUG] Audio message detected.")
                                reply_text = build_audio_reply(driver, sender_name, last_message_container, config, target_data_id=message_data_id)
                            elif message_kind == "media":
                                # Media (image/sticker/GIF) is ignored silently; just mark it seen.
                                print("[DEBUG] Media message ignored (no media handling); marking as seen.")
                                reply_text = None
                            else:
                                print("[DEBUG] Assuming text message.")
                                if not message_text_original:
                                    message_text_original = last_message_container.find_element(By.XPATH, TEXT_IN_MSG_XPATH).text.strip()
                                command_text = extract_bot_command_text(message_text_original)
                                message_text_for_logic = command_text or message_text_original
                                message_text_lower = message_text_for_logic.lower()
                                print(f"[DEBUG] Read text: '{message_text_original}'")

                                CommandClass = get_command_class(message_text_for_logic, config)
                                if CommandClass:
                                    command_instance = CommandClass()
                                    required_context = command_instance.get_required_context()
                                    context_data = {}
                                    if "sender_name" in required_context:
                                        context_data["sender_name"] = sender_name
                                    reply_text = command_instance.execute(config, message_text_for_logic, context_data)
                                    
                                    if shared_bot_state.torture_active and shared_bot_state.torture_target_sender == sender_name:
                                        pass
                                    else:
                                        if reply_text:
                                            send_message_to_current_chat(driver, reply_text)
                                            time.sleep(2)
                                        # Mark seen before continuing, otherwise the command reprocesses every cycle.
                                        mark_seen_signature(last_processed_signature_by_sender, sender_norm, message_signature)
                                        save_seen_state(last_processed_signature_by_sender)
                                        continue
                                        
                                elif message_text_for_logic.lower().startswith("bot."):
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
                                if is_audio:
                                    send_reply(
                                        driver,
                                        reply_text,
                                        quote_container=last_message_container,
                                        quote_data_id=message_data_id,
                                    )
                                else:
                                    send_message_to_current_chat(driver, reply_text)
                            else:
                                print("[DEBUG] No matching logic found for this message.")

                            mark_seen_signature(last_processed_signature_by_sender, sender_norm, message_signature)
                            save_seen_state(last_processed_signature_by_sender)

                            time.sleep(2)
                            print("[DEBUG] Continuing without full page refresh.")

                        else:
                            print(f"[INFO] Sender '{sender_name}' is NOT approved. Ignoring.")
                            print(
                                "[DEBUG] Sender not approved, skipping processing. "
                                f"normalized_sender='{sender_norm}', approved_count={len(approved_senders)}"
                            )

                    except NoSuchElementException as e:
                        print(f"[ERROR] Could not find an element while processing chat. Maybe the page structure changed or an element disappeared. Error: {e}")
                        print("[DEBUG] Skipping current chat and refreshing page to recover.")
                        driver.refresh()
                    except Exception as e:
                        print(f"[ERROR] An unexpected error occurred while processing a chat item ({type(e).__name__}): {e!r}. Refreshing.")
                        driver.refresh()
                else:
                    # WhatsApp can suppress unread badges when the chat is already open.
                    # In that case, still process unseen actionable messages in active approved chat.
                    try:
                        active_sender = get_active_chat_title(driver)
                        active_sender_norm = normalize_sender_name(active_sender) if active_sender else None

                        if active_sender_norm in approved_sender_lookup:
                            last_known_approved_sender_name = active_sender
                            last_known_approved_sender_norm = active_sender_norm

                        effective_sender_name = None
                        effective_sender_norm = None
                        if active_sender_norm in approved_sender_lookup:
                            effective_sender_name = active_sender
                            effective_sender_norm = active_sender_norm
                        elif last_known_approved_sender_norm in approved_sender_lookup:
                            effective_sender_name = last_known_approved_sender_name
                            effective_sender_norm = last_known_approved_sender_norm

                        if effective_sender_norm:
                            queue_candidates = enumerate_incoming_message_candidates(
                                driver,
                                sender_name=effective_sender_name,
                                lookback=25,
                            )
                            if config.get("message_enumeration_debug", True):
                                debug_dump_candidates(queue_candidates, effective_sender_name, tag="active-no-unread")
                                if not queue_candidates:
                                    log_message_dom_probe(driver, tag="active-no-unread-empty")

                            unseen_actionable = []
                            for item in queue_candidates:
                                if has_seen_signature(last_processed_signature_by_sender, effective_sender_norm, item["signature"]):
                                    continue

                                kind = item.get("kind")
                                if kind == "audio":
                                    unseen_actionable.append(item)
                                    continue

                                # Keep active-no-unread focused, but still allow explicit bot commands.
                                if kind == "text":
                                    text_payload = (item.get("text") or "").strip()
                                    if extract_bot_command_text(text_payload):
                                        unseen_actionable.append(item)

                            pending = None
                            if unseen_actionable:
                                if effective_sender_norm not in sender_queue_bootstrapped:
                                    recent_sigs = compute_recent_signatures(queue_candidates, window_minutes=20)
                                    if recent_sigs is None:
                                        pending, recent_sigs = select_first_contact_group(unseen_actionable)
                                    else:
                                        recent_unseen = [it for it in unseen_actionable if it.get("signature") in recent_sigs]
                                        pending = recent_unseen[0] if recent_unseen else None
                                    historical = [
                                        item for item in queue_candidates
                                        if item.get("signature") not in recent_sigs
                                    ]
                                    if historical:
                                        mark_seen_signatures_from_candidates(
                                            last_processed_signature_by_sender,
                                            effective_sender_norm,
                                            historical,
                                        )
                                    sender_queue_bootstrapped.add(effective_sender_norm)
                                    save_seen_state(last_processed_signature_by_sender)
                                    print("[QUEUE] First-contact baseline: recorded old history, processing recent burst window.")
                                else:
                                    pending = unseen_actionable[0]

                            if pending:
                                pending_kind = pending.get("kind")
                                pending_sig = pending.get("signature")
                                pending_container = pending.get("container")
                                pending_data_id = pending.get("data_id")

                                if pending_kind == "audio":
                                    print("[INFO] No unread badge, but found unseen audio in active approved chat. Processing...")
                                    reply_text = build_audio_reply(driver, effective_sender_name, pending_container, config, target_data_id=pending_data_id)
                                elif pending_kind == "text":
                                    print("[INFO] No unread badge, but found unseen text in active approved chat. Processing...")
                                    text_payload = pending.get("text") or ""
                                    reply_text = None
                                    if text_payload:
                                        command_text = extract_bot_command_text(text_payload)
                                        message_text_for_logic = command_text or text_payload
                                        message_text_lower = message_text_for_logic.lower()
                                        CommandClass = get_command_class(message_text_for_logic, config)
                                        if CommandClass:
                                            command_instance = CommandClass()
                                            required_context = command_instance.get_required_context()
                                            context_data = {}
                                            if "sender_name" in required_context:
                                                context_data["sender_name"] = effective_sender_name
                                            reply_text = command_instance.execute(config, message_text_for_logic, context_data)
                                        elif message_text_for_logic.lower().startswith("bot."):
                                            available_commands = sorted(config.get("dynamic_commands", {}).keys())
                                            if available_commands:
                                                commands_list = "\n".join([f"- {cmd}" for cmd in available_commands])
                                                reply_text = (
                                                    "Hmm, I don't quite understand that 'bot.' command. "
                                                    "Perhaps you meant one of these?\n\n"
                                                    f"{commands_list}"
                                                )
                                            else:
                                                reply_text = "I'm a simple bot. I don't have any specific commands configured yet!"
                                        else:
                                            reply_text = get_static_keyword_reply(message_text_lower, config)
                                        if reply_text is None:
                                            reply_text = sentiment_analyzer.analyze(text_payload)
                                            if reply_text:
                                                blob = TextBlob(text_payload)
                                                polarity = blob.sentiment.polarity
                                                sentiment = "Positive" if polarity > 0.1 else "Negative" if polarity < -0.1 else "Neutral"
                                                logger.log_sentiment(effective_sender_name, sentiment, polarity, text_payload)
                                else:
                                    print("[DEBUG] Media in active approved chat ignored (no media handling); marking as seen.")
                                    reply_text = None

                                if reply_text:
                                    print(f"[DEBUG] Preparing to send reply:\n{reply_text}")
                                    if pending_kind == "audio":
                                        send_reply(
                                            driver,
                                            reply_text,
                                            quote_container=pending_container,
                                            quote_data_id=pending_data_id,
                                        )
                                    else:
                                        send_message_to_current_chat(driver, reply_text)
                                mark_seen_signature(last_processed_signature_by_sender, effective_sender_norm, pending_sig)
                                save_seen_state(last_processed_signature_by_sender)
                                time.sleep(2)
                                print("[DEBUG] Continuing without full page refresh.")
                    except Exception:
                        pass

                    now_ts = time.time()
                    if now_ts - last_idle_log_time >= idle_log_every_seconds:
                        print("[DEBUG] Idle: no unread chats in the last cycle(s).")
                        last_idle_log_time = now_ts

                    # Refresh the dashboard chat picker periodically as more chats load.
                    if now_ts - last_known_chats_write >= 20:
                        write_known_chats(driver)
                        last_known_chats_write = now_ts

                time.sleep(5)

            # --- START: MODIFIED EXCEPTION HANDLING FOR RESILIENCE ---
            except (NoSuchElementException, TimeoutException):
                print("[WARNING] Could not find a required element. This can happen during WhatsApp Web layout changes or reloads.")
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