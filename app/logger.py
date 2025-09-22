# app/logger.py
import csv
import os
from datetime import datetime

# The log file will be saved in the 'logs' volume mount
LOG_FILE_PATH = 'logs/sentiment_log.csv'
LOG_HEADER = ['Timestamp', 'Sender', 'Sentiment', 'Polarity Score', 'Message']

def log_sentiment(sender, sentiment, score, message):
    """
    Appends a new row to the sentiment log CSV file.
    """
    print(f"[LOGGER] Logging sentiment data for sender: {sender}")
    
    # Get the current time for the log entry
    timestamp = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    
    # The data for our new row
    new_row = [timestamp, sender, sentiment, f"{score:.2f}", message]
    
    try:
        # Check if the file exists to determine if we need to write the header
        file_exists = os.path.isfile(LOG_FILE_PATH)
        
        # Open the file in 'append' mode ('a'), which creates the file if it doesn't exist.
        # 'newline=""' is important to prevent blank rows in the CSV.
        with open(LOG_FILE_PATH, 'a', newline='', encoding='utf-8') as csvfile:
            writer = csv.writer(csvfile)
            
            # If the file is new, write the header row first
            if not file_exists:
                writer.writerow(LOG_HEADER)
            
            # Write the new data row
            writer.writerow(new_row)
            
        print("[LOGGER] Successfully logged data.")
            
    except Exception as e:
        print(f"[ERROR] Could not write to log file: {e}")