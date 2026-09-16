declare module "sentiment" {
  interface SentimentAnalysis {
    score: number;
    comparative: number;
    tokens: string[];
    words: string[];
    positive: string[];
    negative: string[];
  }

  export default class Sentiment {
    analyze(phrase: string, options?: unknown): SentimentAnalysis;
  }
}
