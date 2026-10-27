import type { Handler } from "../../router/router.js";
import type { AchievementStore } from "../../state/achievements.js";
import { chatKey } from "./user-context.js";
import { messagePerson } from "./local-target.js";

export function makeAchievements(achievements: AchievementStore): Handler {
  return async (ctx) => {
    const chat = chatKey(ctx.msg);
    if (!achievements.enabled(chat)) {
      await ctx.reply("Achievements are disabled in this chat. The owner can enable them under Access in the dashboard for approved chats.");
      return;
    }
    if (ctx.args.trim()) {
      await ctx.reply("Use bot.achievements without arguments to see your badges and progress in this chat.");
      return;
    }
    await ctx.reply(achievements.describe(chat, messagePerson(ctx.msg)));
  };
}
