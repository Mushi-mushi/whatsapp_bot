import type { Handler } from "../../router/router.js";
import { ollamaChat, ollamaErrorMessage } from "../../util/ollama.js";

// Pipe the user's prompt to a local Ollama model and reply with the answer.
export const ask: Handler = async (ctx) => {
  const cfg = ctx.config;
  if (!cfg.askEnabled) {
    await ctx.reply("The ask command is currently disabled.");
    return;
  }
  const prompt = ctx.args.trim();
  if (!prompt) {
    await ctx.reply("Ask me anything! Usage: `bot.ask What is the capital of France?`");
    return;
  }

  const r = await ollamaChat(cfg, [
    {
      role: "system",
      content:
        cfg.askSystemPrompt?.trim() ||
        "You are a helpful assistant answering inside a WhatsApp chat. Be concise and friendly. Reply in plain text (no markdown).",
    },
    { role: "user", content: prompt },
  ]);
  await ctx.reply(r.ok ? `🧠 ${r.content}` : ollamaErrorMessage(r, cfg.ollamaModel));
};
