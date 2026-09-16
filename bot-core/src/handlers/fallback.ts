import type { Handler } from "../router/router.js";
import type { RuntimeState } from "../state/runtime.js";
import type { SentimentStore } from "../state/repos.js";
import { analyzeSentiment } from "../analyzers/sentiment.js";
import { checkComeback } from "./insults/game.js";

export interface FallbackDeps {
  runtime: RuntimeState;
  sentiment: SentimentStore;
}

// Handles free-form (non-command) text: active insult duels, static keyword
// replies, then passive sentiment logging.
export function makeFallback(deps: FallbackDeps): Handler {
  return async (ctx) => {
    const text = ctx.text.trim();
    if (!text) return;

    // 1) Active insult duel in this chat — treat the message as a comeback.
    const game = deps.runtime.insultGames.get(ctx.msg.chatId);
    if (game && game.currentInsultIndex !== null) {
      const result = checkComeback(game, text);
      if (result.finished) deps.runtime.insultGames.delete(ctx.msg.chatId);
      await ctx.reply(result.text);
      return;
    }

    // 2) Static keyword responses (exact, case-insensitive match).
    const reply = ctx.config.keywordResponses[text.toLowerCase()];
    if (reply) {
      await ctx.reply(reply);
      return;
    }

    // 3) Passive sentiment logging (no reply).
    const { label, polarity } = analyzeSentiment(text);
    deps.sentiment.log(ctx.msg.senderName || ctx.msg.chatName || "unknown", label, polarity, text);
  };
}
