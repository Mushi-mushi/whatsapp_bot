import type { Handler } from "../../router/router.js";
import type { SentimentEntry, SentimentStore } from "../../state/repos.js";
import { chatKey } from "./user-context.js";

function format(title: string, entries: SentimentEntry[]): string {
  const lines = entries.map(
    (e, i) =>
      `${i + 1}. Sender: ${e.sender}\n   Score: ${e.polarity.toFixed(2)}\n   Message: "${e.message}"`,
  );
  return `${title}\n\n${lines.join("\n\n")}`;
}

export function makeTopPositive(sentiment: SentimentStore): Handler {
  return (ctx) => {
    const entries = sentiment.top(chatKey(ctx.msg), "DESC", 5);
    if (entries.length === 0) return ctx.reply("No sentiment data has been logged yet.");
    return ctx.reply(format("Top 5 Most Positive Logged Messages:", entries));
  };
}

export function makeTopNegative(sentiment: SentimentStore): Handler {
  return (ctx) => {
    const entries = sentiment.top(chatKey(ctx.msg), "ASC", 5);
    if (entries.length === 0) return ctx.reply("No sentiment data has been logged yet.");
    return ctx.reply(format("Top 5 Most Negative Logged Messages:", entries));
  };
}
