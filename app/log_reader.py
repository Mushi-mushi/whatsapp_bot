# app/log_reader.py
import csv
import os

LOG_FILE_PATH = 'logs/sentiment_log.csv'

def read_log_file():
    """Reads the sentiment log CSV and returns it as a list of dictionaries."""
    if not os.path.isfile(LOG_FILE_PATH):
        return [] # Return an empty list if the log file doesn't exist yet

    log_entries = []
    try:
        with open(LOG_FILE_PATH, 'r', newline='', encoding='utf-8') as csvfile:
            reader = csv.DictReader(csvfile)
            for row in reader:
                try:
                    # Convert score to float for sorting/calculation
                    row['Polarity Score'] = float(row['Polarity Score'])
                    log_entries.append(row)
                except (ValueError, KeyError):
                    # Skip any rows that have malformed data
                    continue
        return log_entries
    except Exception as e:
        print(f"[ERROR] Could not read or parse log file: {e}")
        return []