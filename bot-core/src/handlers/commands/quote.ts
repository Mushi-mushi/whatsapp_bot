import type { Handler } from "../../router/router.js";

async function fromZenQuotes(): Promise<string | null> {
  try {
    const res = await fetch("https://zenquotes.io/api/random", {
      signal: AbortSignal.timeout(8000),
    });
    if (res.ok) {
      const data = (await res.json()) as Array<{ q?: string; a?: string }>;
      const item = data[0];
      if (item?.q) return `"${item.q.trim()}"${item.a ? ` — ${item.a.trim()}` : ""}`;
    }
  } catch {
    /* fall through */
  }
  return null;
}

async function fromQuotable(): Promise<string | null> {
  try {
    const res = await fetch("https://api.quotable.io/random", {
      signal: AbortSignal.timeout(8000),
    });
    if (res.ok) {
      const data = (await res.json()) as { content?: string; author?: string };
      if (data.content) return `"${data.content.trim()}"${data.author ? ` — ${data.author}` : ""}`;
    }
  } catch {
    /* fall through */
  }
  return null;
}

export const quote: Handler = async (ctx) => {
  const q = (await fromZenQuotes()) ?? (await fromQuotable());
  await ctx.reply(q ? `💬 ${q}` : "The muses are quiet right now. Try again in a moment!");
};
