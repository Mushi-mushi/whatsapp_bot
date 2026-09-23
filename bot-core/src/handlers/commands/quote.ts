import type { Handler } from "../../router/router.js";
import { tryJson } from "../../util/http.js";

async function fromZenQuotes(): Promise<string | null> {
  const data = await tryJson<Array<{ q?: string; a?: string }>>("https://zenquotes.io/api/random");
  const item = data?.[0];
  if (item?.q) return `"${item.q.trim()}"${item.a ? ` — ${item.a.trim()}` : ""}`;
  return null;
}

async function fromQuotable(): Promise<string | null> {
  const data = await tryJson<{ content?: string; author?: string }>(
    "https://api.quotable.io/random",
  );
  if (data?.content) return `"${data.content.trim()}"${data.author ? ` — ${data.author}` : ""}`;
  return null;
}

export const quote: Handler = async (ctx) => {
  const q = (await fromZenQuotes()) ?? (await fromQuotable());
  await ctx.reply(q ? `💬 ${q}` : "The muses are quiet right now. Try again in a moment!");
};
