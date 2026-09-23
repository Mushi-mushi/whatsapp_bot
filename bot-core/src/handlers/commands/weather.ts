import type { Handler } from "../../router/router.js";
import { tryText } from "../../util/http.js";

// wttr.in gives a compact one-line forecast; fall back to http if https is blocked.
async function fetchWeather(location: string): Promise<string | null> {
  const path = `${encodeURIComponent(location)}?format=%l:+%c+%t+(feels+%f),+%h+humidity,+wind+%w`;
  for (const base of ["https://wttr.in", "http://wttr.in"]) {
    const text = (await tryText(`${base}/${path}`, { headers: { "User-Agent": "curl/8" } }))?.trim();
    if (text && !/unknown location/i.test(text)) return text;
  }
  return null;
}

export const weather: Handler = async (ctx) => {
  const location = ctx.args.trim();
  if (!location) {
    await ctx.reply("Where should I look? Try `bot.weather Madrid`.");
    return;
  }
  const report = await fetchWeather(location);
  await ctx.reply(
    report ? `🌤️ ${report}` : `I couldn't reach the weather service for "${location}". Try again shortly.`,
  );
};
