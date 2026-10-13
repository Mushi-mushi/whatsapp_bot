import type { Handler } from "../../router/router.js";
import type { UserMemoryStore } from "../../state/repos.js";
import type { ProfileService } from "../profiles/service.js";
import { ollamaChat, ollamaErrorMessage } from "../../util/ollama.js";
import { rememberMessage } from "./user-context.js";

// bot.translate <language> <text> — local LLM translation.
export function makeTranslate(userMemory: UserMemoryStore, profiler: ProfileService): Handler {
  return async (ctx) => {
    const cfg = ctx.config;
    if (!cfg.askEnabled) {
      await ctx.reply("AI features are disabled (enable them in Settings).");
      return;
    }
    const args = ctx.args.trim();
    const sp = args.indexOf(" ");
    if (sp < 0) {
      await ctx.reply("Usage: `bot.translate French Hello, how are you?`");
      return;
    }
    const lang = args.slice(0, sp).trim();
    const text = args.slice(sp + 1).trim();
    if (!text) {
      await ctx.reply("Usage: `bot.translate French Hello, how are you?`");
      return;
    }

    const r = await ollamaChat(cfg, [
      {
        role: "system",
        content: `You are a translation engine. Translate the user's text into ${lang}. Output ONLY the translation — no quotes, no notes, no explanation.`,
      },
      { role: "user", content: text },
    ]);
    await ctx.reply(r.ok ? `🌐 ${r.content}` : ollamaErrorMessage(r, cfg.ollamaModel));

    rememberMessage(userMemory, profiler, ctx.msg, cfg, `(asked to translate to ${lang}) ${text}`);
  };
}
