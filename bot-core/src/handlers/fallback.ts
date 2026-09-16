import type { Handler } from "../router/router.js";
import type { RuntimeState } from "../state/runtime.js";
import type { SentimentStore, TriviaScoreStore } from "../state/repos.js";
import { analyzeSentiment } from "../analyzers/sentiment.js";
import { normalizeName } from "../router/normalize.js";
import { checkComeback } from "./insults/game.js";
import { checkTriviaAnswer, clearTrivia, startQuestion } from "./commands/trivia.js";

export interface FallbackDeps {
  runtime: RuntimeState;
  sentiment: SentimentStore;
  triviaScores: TriviaScoreStore;
}

// Handles free-form (non-command) text: active games, static keyword replies,
// then passive sentiment logging.
export function makeFallback(deps: FallbackDeps): Handler {
  return async (ctx) => {
    const text = ctx.text.trim();
    if (!text) return;

    // 1) Active trivia question — a correct answer scores + ends it; a wrong
    // attempt keeps it open; anything unrecognizable falls through.
    const trivia = deps.runtime.triviaGames.get(ctx.msg.chatId);
    if (trivia) {
      const result = checkTriviaAnswer(trivia, text);
      if (result) {
        if (result.correct) {
          clearTrivia(trivia);
          deps.runtime.triviaGames.delete(ctx.msg.chatId);
          const points = deps.triviaScores.increment(
            ctx.msg.chatId,
            normalizeName(ctx.msg.senderName),
            ctx.msg.senderName,
          );
          await ctx.reply(
            `✅ Correct, ${ctx.msg.senderName}! The answer is "${trivia.correct}". (${points} point${points === 1 ? "" : "s"}) Next up…`,
          );
          // Continuous quiz: roll straight into the next question, same category.
          const category = trivia.categoryId
            ? { id: trivia.categoryId, name: trivia.categoryName ?? "" }
            : undefined;
          await startQuestion(deps.runtime, ctx.msg.chatId, (t) => ctx.reply(t), category);
        } else {
          await ctx.reply(`❌ Not that one, ${ctx.msg.senderName} — keep trying!`);
        }
        return;
      }
    }

    // 2) Active insult duel in this chat — treat the message as a comeback.
    const game = deps.runtime.insultGames.get(ctx.msg.chatId);
    if (game && game.currentInsultIndex !== null) {
      const result = checkComeback(game, text);
      if (result.finished) deps.runtime.insultGames.delete(ctx.msg.chatId);
      await ctx.reply(result.text);
      return;
    }

    // 3) Static keyword responses (exact, case-insensitive match).
    const reply = ctx.config.keywordResponses[text.toLowerCase()];
    if (reply) {
      await ctx.reply(reply);
      return;
    }

    // 4) Passive sentiment logging (no reply).
    const { label, polarity } = analyzeSentiment(text);
    deps.sentiment.log(ctx.msg.senderName || ctx.msg.chatName || "unknown", label, polarity, text);
  };
}
