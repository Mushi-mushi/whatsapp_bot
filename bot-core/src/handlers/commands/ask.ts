import type { Handler } from "../../router/router.js";

interface OllamaChatResponse {
  message?: { content?: string };
  error?: string;
}

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

  const base = cfg.ollamaBaseUrl.replace(/\/+$/, "");
  try {
    const res = await fetch(`${base}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: cfg.ollamaModel,
        stream: false,
        messages: [
          {
            role: "system",
            content:
              "You are a helpful assistant answering inside a WhatsApp chat. Be concise and friendly. Reply in plain text (no markdown).",
          },
          { role: "user", content: prompt },
        ],
      }),
      signal: AbortSignal.timeout(cfg.ollamaTimeoutSeconds * 1000),
    });

    if (!res.ok) {
      if (res.status === 404) {
        await ctx.reply(
          `Model "${cfg.ollamaModel}" isn't available on Ollama. Check the model name in Settings.`,
        );
        return;
      }
      await ctx.reply(`Ollama returned an error (${res.status}). Is it running?`);
      return;
    }

    const data = (await res.json()) as OllamaChatResponse;
    const answer = data.message?.content?.trim();
    await ctx.reply(answer ? `🧠 ${answer}` : "The model gave me an empty answer. Try rephrasing?");
  } catch (err) {
    const timedOut = err instanceof Error && err.name === "TimeoutError";
    await ctx.reply(
      timedOut
        ? "The model took too long to answer. Try a shorter prompt or a faster model."
        : "I couldn't reach Ollama. Make sure it's running on the host.",
    );
  }
};
