import type { Handler } from "../../router/router.js";
import type { RemindersStore } from "../../state/repos.js";
import type { ReminderRecurrence } from "../../../../shared/api.js";
import { formatDuration, parseDuration } from "../../util/time.js";

const MAX_MS = 7 * 86_400_000; // cap reminders at 7 days

// bot.remind me in 10m to buy milk  |  bot.remind 2h stretch  |  bot.remind daily 9h standup
export function makeRemind(reminders: RemindersStore): Handler {
  return (ctx) => {
    let rest = ctx.args.trim();
    if (!rest) {
      return ctx.reply("Usage: `bot.remind [daily|weekly] 10m take the pizza out` (units: s/m/h/d).");
    }
    // Strip a leading "me" for natural phrasing.
    rest = rest.replace(/^me\s+/i, "");

    let recurrence: ReminderRecurrence = "once";
    const recMatch = /^(?:(daily|every\s+day)|(weekly|every\s+week))\s+/i.exec(rest);
    if (recMatch) {
      recurrence = recMatch[1] ? "daily" : "weekly";
      rest = rest.slice(recMatch[0].length);
    }
    rest = rest.replace(/^in\s+/i, "");

    const parsed = parseDuration(rest);
    if (!parsed) {
      return ctx.reply("I couldn't read the time. Try `bot.remind 10m water the plants` or `bot.remind daily 8h standup`.");
    }
    if (parsed.ms > MAX_MS) {
      return ctx.reply("I can only remind you up to 7 days ahead.");
    }
    // Allow an optional "to " before the reminder text.
    const text = parsed.rest.replace(/^to\s+/i, "").trim();
    if (!text) {
      return ctx.reply("What should I remind you about? e.g. `bot.remind 10m call mom`.");
    }

    reminders.add(ctx.msg.chatId, ctx.msg.senderName, text, Date.now() + parsed.ms, recurrence);
    const repeatLabel = recurrence === "daily" ? " (repeats daily)" : recurrence === "weekly" ? " (repeats weekly)" : "";
    return ctx.reply(`⏰ Okay, I'll remind you in ${formatDuration(parsed.ms)}${repeatLabel}: ${text}`);
  };
}
