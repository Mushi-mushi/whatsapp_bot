import type { Handler } from "../../router/router.js";
import type { SuggestionStore } from "../../state/repos.js";
import { chatKey } from "./user-context.js";
import { messagePerson } from "./local-target.js";

const RESPONSES = [
  (n: string) =>
    `💡 Idea noted, ${n}! Added to the Official Bot Wish List.`,
  (n: string) =>
    `📝 Got it, ${n}! Your suggestion has been logged for future upgrades.`,
  (n: string) =>
    `✨ Ooh, a feature idea from ${n}! Saved to the suggestion box.`,
];

export function makeSuggest(suggestions: SuggestionStore): Handler {
  return (ctx) => {
    const sender = ctx.msg.senderName || "Valued User";
    const idea = ctx.args.trim();
    if (!idea) {
      return ctx.reply("Got a feature idea? Usage: `bot.suggest Add a daily horoscope command`");
    }
    suggestions.log(chatKey(ctx.msg), messagePerson(ctx.msg), sender, "explicit", idea, null);
    const line = RESPONSES[Math.floor(Math.random() * RESPONSES.length)](sender);
    return ctx.reply(line);
  };
}
