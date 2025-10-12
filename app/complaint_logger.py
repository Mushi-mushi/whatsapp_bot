# app/complaint_logger.py
import csv
import os
from datetime import datetime

# The log file will be saved in the 'logs' volume mount
LOG_FILE_PATH = 'logs/complaint_log.csv'
LOG_HEADER = ['Timestamp', 'Sender', 'Complaint Message']

def log_complaint(sender, message):
    """
    Appends a new row to the complaint log CSV file.
    """
    print(f"[COMPLAINT_LOGGER] Logging complaint from sender: {sender}")

    timestamp = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    new_row = [timestamp, sender, message]

    try:
        file_exists = os.path.isfile(LOG_FILE_PATH)

        with open(LOG_FILE_PATH, 'a', newline='', encoding='utf-8') as csvfile:
            writer = csv.writer(csvfile)

            if not file_exists:
                writer.writerow(LOG_HEADER)

            writer.writerow(new_row)

        print("[COMPLAINT_LOGGER] Successfully logged complaint.")

    except Exception as e:
        print(f"[ERROR] Could not write to complaint log file: {e}")