import type { Handler } from "../../router/router.js";
import { tryJson } from "../../util/http.js";

export const fact: Handler = async (ctx) => {
  const data = await tryJson<{ text?: string }>(
    "https://uselessfacts.jsph.pl/api/v2/facts/random?language=en",
    { headers: { Accept: "application/json" } },
  );
  if (data?.text) {
    await ctx.reply(`🧠 ${data.text.trim()}`);
    return;
  }
  await ctx.reply("My fact vault is jammed right now. Try again in a moment!");
};
