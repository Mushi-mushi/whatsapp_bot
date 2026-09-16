import type { Handler } from "../../router/router.js";
import { ollamaChat, ollamaErrorMessage } from "../../util/ollama.js";
import { extractReadable, isSafeHttpUrl } from "../../util/net.js";

// bot.tldr <url> — fetch a web page and summarize it with the local LLM.
export const tldr: Handler = async (ctx) => {
  const cfg = ctx.config;
  if (!cfg.askEnabled) {
    await ctx.reply("AI features are disabled (enable them in Settings).");
    return;
  }
  const url = ctx.args.trim().split(/\s+/)[0];
  if (!url || !isSafeHttpUrl(url)) {
    await ctx.reply("Usage: `bot.tldr https://example.com/article` (public http/https pages only).");
    return;
  }

  let html: string;
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; whatsapp-bot tldr)" },
      signal: AbortSignal.timeout(15000),
      redirect: "follow",
    });
    if (!res.ok) {
      await ctx.reply(`Couldn't fetch that page (${res.status}).`);
      return;
    }
    const ct = res.headers.get("content-type") ?? "";
    if (!ct.includes("text/html") && !ct.includes("text/plain")) {
      await ctx.reply("That link isn't a readable web page.");
      return;
    }
    html = (await res.text()).slice(0, 400_000);
  } catch (err) {
    const timedOut = err instanceof Error && err.name === "TimeoutError";
    await ctx.reply(timedOut ? "Fetching that page timed out." : "I couldn't reach that URL.");
    return;
  }

  const { title, text } = extractReadable(html);
  if (text.length < 200) {
    await ctx.reply("I couldn't find enough readable text on that page.");
    return;
  }

  const r = await ollamaChat(cfg, [
    {
      role: "system",
      content:
        "Summarize the following web page in 3-5 concise bullet points using '-' bullets. Plain text only, be factual, no preamble.",
    },
    { role: "user", content: `${title ? `Title: ${title}\n\n` : ""}${text.slice(0, 6000)}` },
  ]);
  if (!r.ok) {
    await ctx.reply(ollamaErrorMessage(r, cfg.ollamaModel));
    return;
  }
  await ctx.reply(`📰 ${title ? `${title}\n` : ""}${r.content}`);
};
