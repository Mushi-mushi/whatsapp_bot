# app/analyzers/sentiment_analyzer.py
from textblob import TextBlob

# Define the keywords that will trigger this analyzer
TRIGGER_KEYWORDS = ["france", "french"]

def analyze(message_text):
    """
    If the message contains trigger keywords, performs sentiment analysis.
    Returns a reply string with the analysis, or None if no keywords are found.
    """
    message_lower = message_text.lower()
    
    # Check if any of the trigger keywords are in the message
    if any(keyword in message_lower for keyword in TRIGGER_KEYWORDS):
        print(f"[ANALYZER] Trigger keywords found in message. Running sentiment analysis.")
        
        # Perform the sentiment analysis using TextBlob
        blob = TextBlob(message_text)
        polarity = blob.sentiment.polarity
        
        # Determine the sentiment category
        if polarity > 0.1:
            sentiment = "Positive"
        elif polarity < -0.1:
            sentiment = "Negative"
        else:
            sentiment = "Neutral"
            
        # Format the reply
        reply = (
            f"Sentiment Analysis Result:\n"
            f"- Category: {sentiment}\n"
            f"- Polarity Score: {polarity:.2f}"
        )
        return reply
        
    # If no trigger keywords are found, do nothing
    return None