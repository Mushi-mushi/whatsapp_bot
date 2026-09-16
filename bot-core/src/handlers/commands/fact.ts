import type { Handler } from "../../router/router.js";

export const fact: Handler = async (ctx) => {
  try {
    const res = await fetch("https://uselessfacts.jsph.pl/api/v2/facts/random?language=en", {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(8000),
    });
    if (res.ok) {
      const data = (await res.json()) as { text?: string };
      if (data.text) {
        await ctx.reply(`🧠 ${data.text.trim()}`);
        return;
      }
    }
  } catch {
    /* fall through */
  }
  await ctx.reply("My fact vault is jammed right now. Try again in a moment!");
};
