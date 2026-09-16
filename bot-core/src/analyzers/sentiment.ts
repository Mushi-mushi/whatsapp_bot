import Sentiment from "sentiment";

const analyzer = new Sentiment();

export interface SentimentResult {
  label: "positive" | "negative" | "neutral";
  polarity: number; // clamped to [-1, 1], comparable to TextBlob polarity
}

// Analyze text and return a TextBlob-style polarity in [-1, 1] plus a label.
export function analyzeSentiment(text: string): SentimentResult {
  const { comparative } = analyzer.analyze(text);
  const polarity = Math.max(-1, Math.min(1, comparative));
  const label = polarity > 0.05 ? "positive" : polarity < -0.05 ? "negative" : "neutral";
  return { label, polarity };
}
