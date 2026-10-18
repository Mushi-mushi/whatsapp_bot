import type { Handler } from "../router/router.js";
import { chatKey } from "./commands/user-context.js";
import { messagePerson } from "./commands/local-target.js";
import type { RuntimeState } from "../state/runtime.js";
import type { SentimentStore, TriviaScoreStore, DuelWinStore, UserMemoryStore } from "../state/repos.js";
import type { ProfileService } from "./profiles/service.js";
import { analyzeSentiment } from "../analyzers/sentiment.js";
import { senderKey } from "./commands/user-context.js";
import { checkComeback } from "./insults/game.js";
import { handleTriviaAnswer } from "./commands/trivia.js";

export interface FallbackDeps {
  runtime: RuntimeState;
  sentiment: SentimentStore;
  triviaScores: TriviaScoreStore;
  duelScores: DuelWinStore;
  userMemory: UserMemoryStore;
  profiler: ProfileService;
}

// Handles free-form (non-command) text: active games, static keyword replies,
// then passive sentiment logging.
export function makeFallback(deps: FallbackDeps): Handler {
  return async (ctx) => {
    const text = ctx.text.trim();
    if (!text) return;

    // 1) Active trivia question (classic or duel). Returns true when the message
    // was consumed as an answer; stale/non-answer/non-participant messages fall
    // through to the handlers below.
    const consumed = await handleTriviaAnswer({
      runtime: deps.runtime,
      scores: deps.triviaScores,
      duelScores: deps.duelScores,
      chatId: chatKey(ctx.msg),
      senderId: messagePerson(ctx.msg),
      senderName: ctx.msg.senderName,
      text,
      sentAt: ctx.msg.timestamp,
      cfg: ctx.config,
      reply: (t) => ctx.reply(t),
    });
    if (consumed) return;

    // 2) Active insult duel in this chat — treat the message as a comeback.
    const insultChat = [...deps.runtime.insultGames.keys()].find((key) =>
      deps.triviaScores.canonicalPerson(key) === deps.triviaScores.canonicalPerson(chatKey(ctx.msg)));
    const game = insultChat ? deps.runtime.insultGames.get(insultChat) : undefined;
    if (insultChat && game && game.currentInsultIndex !== null &&
        deps.triviaScores.canonicalPerson(game.targetId) === deps.triviaScores.canonicalPerson(messagePerson(ctx.msg))) {
      const result = checkComeback(game, text);
      if (result.finished) deps.runtime.insultGames.delete(insultChat);
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
    deps.sentiment.log(chatKey(ctx.msg), messagePerson(ctx.msg), ctx.msg.senderName || "unknown", label, polarity, text);

    // 5) Passive per-user memory: remember substantial free-form chatter so
    // bot.ask / bot.profile can personalise. Keyed by a stable identity (phone/
    // jid), not display name. Skips very short noise (e.g. "ok").
    const cfg = ctx.config;
    if (cfg.userMemoryEnabled && !ctx.msg.fromMe && text.length >= 6) {
      const name = ctx.msg.senderName?.trim();
      const key = senderKey(ctx.msg);
      if (key && name) {
        deps.userMemory.record(key, name, ctx.msg.chatName || null, text, cfg.userMemoryLimit);
        // Rebuild the personality profile in the background when it goes stale.
        deps.profiler.maybeRefresh(key, name);
      }
    }
  };
}
