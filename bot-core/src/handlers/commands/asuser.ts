import type { Handler } from "../../router/router.js";
import type { KnownUser, UserMemoryStore } from "../../state/repos.js";
import type { ProfileService } from "../profiles/service.js";
import { ollamaChat, ollamaErrorMessage, type OllamaMessage } from "../../util/ollama.js";
import { normalizeName } from "../../router/normalize.js";
import { chatKey } from "./user-context.js";

// bot.as <name>: <question> — answer a question in the voice of a profiled person,
// using the dossier the bot has learned about them. The name and question may be
// split by a colon; without one, the longest leading run of words that matches a
// known person in this chat is taken as the name (so multi-word names work).
export function makeAsUser(userMemory: UserMemoryStore, profiler: ProfileService): Handler {
  return async (ctx) => {
    const cfg = ctx.config;
    if (!cfg.askEnabled) {
      await ctx.reply("The AI features are currently disabled.");
      return;
    }
    if (!cfg.userMemoryEnabled) {
      await ctx.reply("User memory is disabled, so I don't know anyone to impersonate.");
      return;
    }

    const raw = ctx.args.trim();
    if (!raw) {
      await ctx.reply("Usage: `bot.as <name>: <question>` — e.g. `bot.as Alice: what do you think of Mondays?`");
      return;
    }

    let ambiguous = false;
    const resolve = (n: string): KnownUser | undefined => {
      const norm = normalizeName(n);
      if (!norm) return undefined;
      const matches = userMemory.usersForNameInChat(norm, chatKey(ctx.msg));
      ambiguous = matches.length > 1;
      return matches.length === 1 ? matches[0] : undefined;
    };

    let name = "";
    let question = "";
    let match: KnownUser | undefined;

    const colon = raw.indexOf(":");
    if (colon >= 0) {
      name = raw.slice(0, colon).trim();
      question = raw.slice(colon + 1).trim();
      match = resolve(name);
    } else {
      // No separator: greedily match the longest leading name (supports multi-word
      // names like "Si Ying") against people active in this chat.
      const words = raw.split(/\s+/);
      for (let n = Math.min(words.length - 1, 5); n >= 1 && !match && !ambiguous; n--) {
        const candidate = words.slice(0, n).join(" ");
        const m = resolve(candidate);
        if (m) {
          name = candidate;
          question = words.slice(n).join(" ");
          match = m;
        }
      }
      if (!match) {
        name = words[0] ?? "";
        question = words.slice(1).join(" ");
      }
    }

    if (ambiguous) {
      await ctx.reply("More than one person has that name in this chat, so I won't guess who to impersonate.");
      return;
    }
    if (!name || !question) {
      await ctx.reply("Usage: `bot.as <name>: <question>` — e.g. `bot.as Alice: what do you think of Mondays?`");
      return;
    }

    // Only impersonate people active in THIS chat, so you can't conjure the
    // persona of someone who isn't here.
    if (!match) {
      await ctx.reply(`I haven't heard from anyone called "${name}" in this chat yet, so I can't speak as them.`);
      return;
    }

    // Refresh so the persona reflects their latest messages, falling back to any
    // stored dossier or short briefing.
    const refreshed = await profiler.refresh(match.sender_key, match.name, cfg);
    const profile = refreshed ?? profiler.deepFor(match.sender_key);
    const persona = profile?.deep?.trim() || profiler.shortFor(match.sender_key);
    if (!persona) {
      await ctx.reply(`I don't know enough about "${match.name}" yet to impersonate them. Let them chat a bit more.`);
      return;
    }

    const system =
      `You are role-playing as ${match.name}. Answer the question in the first person, as if you were them, ` +
      "matching their personality, opinions, interests, and communication style described below. " +
      "Stay in character, be concise, and reply in plain text (no markdown). Do not mention that you are an AI or that you have a profile.\n\n" +
      `Persona of ${match.name}:\n${persona}`;
    const messages: OllamaMessage[] = [
      { role: "system", content: system },
      { role: "user", content: question },
    ];

    const r = await ollamaChat(cfg, messages);
    await ctx.reply(r.ok ? `🎭 ${match.name}: ${r.content}` : ollamaErrorMessage(r, cfg.ollamaModel));
  };
}
