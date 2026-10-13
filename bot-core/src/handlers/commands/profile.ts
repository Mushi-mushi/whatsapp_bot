import type { Handler } from "../../router/router.js";
import type { UserMemoryStore } from "../../state/repos.js";
import type { ProfileService } from "../profiles/service.js";
import { normalizeName } from "../../router/normalize.js";
import { senderKey } from "./user-context.js";

// bot.profile [name] — rebuild and show the deep personality dossier the bot has
// learned about a person. With no name, profiles the sender. Resolves a typed
// name back to the most-recently-active identity using it.
export function makeProfile(userMemory: UserMemoryStore, profiler: ProfileService): Handler {
  return async (ctx) => {
    const cfg = ctx.config;
    if (!cfg.userMemoryEnabled) {
      await ctx.reply("User memory is currently disabled, so I'm not learning about anyone.");
      return;
    }
    if (!cfg.askEnabled) {
      await ctx.reply("The AI features are currently disabled.");
      return;
    }

    const target = ctx.args.trim();
    const askingSelf = target.length === 0;

    // Self → use the sender's own stable identity. Named → resolve the typed name
    // back to the most-recently-active identity using it.
    let key: string;
    let displayName: string;
    if (askingSelf) {
      key = senderKey(ctx.msg);
      displayName = ctx.msg.senderName?.trim() || "you";
    } else {
      const match = userMemory.keyForName(normalizeName(target));
      if (!match) {
        await ctx.reply(`I haven't heard from anyone called "${target}" yet.`);
        return;
      }
      key = match.sender_key;
      displayName = match.name;
    }

    // Rebuild from the latest messages, falling back to any stored dossier.
    const refreshed = await profiler.refresh(key, displayName, cfg);
    const profile = refreshed ?? profiler.deepFor(key);
    if (!profile) {
      await ctx.reply(
        askingSelf
          ? "I haven't heard enough from you yet. Chat a bit and try again!"
          : `I don't know enough about "${displayName}" yet.`,
      );
      return;
    }

    await ctx.reply(`🪪 ${displayName}\n${profile.deep}`);
  };
}
