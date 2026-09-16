import type { Handler } from "../../router/router.js";
import type { RemindersStore } from "../../state/repos.js";
import { formatDuration, parseDuration } from "../../util/time.js";

const MAX_MS = 7 * 86_400_000; // cap reminders at 7 days

// bot.remind me in 10m to buy milk  |  bot.remind 2h stretch  |  bot.remind 30s ping
export function makeRemind(reminders: RemindersStore): Handler {
  return (ctx) => {
    let rest = ctx.args.trim();
    if (!rest) {
      return ctx.reply("Usage: `bot.remind 10m take the pizza out` (units: s/m/h/d).");
    }
    // Strip a leading "me" and/or "in" for natural phrasing.
    rest = rest.replace(/^(me\s+)?(in\s+)?/i, "");

    const parsed = parseDuration(rest);
    if (!parsed) {
      return ctx.reply("I couldn't read the time. Try `bot.remind 10m water the plants`.");
    }
    if (parsed.ms > MAX_MS) {
      return ctx.reply("I can only remind you up to 7 days ahead.");
    }
    // Allow an optional "to " before the reminder text.
    const text = parsed.rest.replace(/^to\s+/i, "").trim();
    if (!text) {
      return ctx.reply("What should I remind you about? e.g. `bot.remind 10m call mom`.");
    }

    reminders.add(ctx.msg.chatId, ctx.msg.senderName, text, Date.now() + parsed.ms);
    return ctx.reply(`⏰ Okay, I'll remind you in ${formatDuration(parsed.ms)}: ${text}`);
  };
}
