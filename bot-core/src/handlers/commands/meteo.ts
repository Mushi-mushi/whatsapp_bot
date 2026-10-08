import type { Handler } from "../../router/router.js";
import { tryJson } from "../../util/http.js";

const DEFAULT_LOCATION = "Barcelona";

interface WttrForecast {
  nearest_area?: Array<{ areaName?: Array<{ value: string }> }>;
  weather?: Array<{
    date: string;
    maxtempC: string;
    mintempC: string;
    hourly?: Array<{ time: string; weatherDesc?: Array<{ value: string }> }>;
  }>;
}

// wttr.in's j1 format returns a structured 3-day forecast; fall back to http if https is blocked.
async function fetchForecast(location: string): Promise<WttrForecast | null> {
  const path = `${encodeURIComponent(location)}?format=j1`;
  for (const base of ["https://wttr.in", "http://wttr.in"]) {
    const data = await tryJson<WttrForecast>(`${base}/${path}`, { headers: { "User-Agent": "curl/8" } });
    if (data?.weather?.length) return data;
  }
  return null;
}

function formatDay(date: string): string {
  const parsed = new Date(`${date}T12:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return date;
  return parsed.toLocaleDateString("en-GB", { weekday: "short", day: "2-digit", month: "short", timeZone: "UTC" });
}

export const meteo: Handler = async (ctx) => {
  const location = ctx.args.trim() || DEFAULT_LOCATION;
  const forecast = await fetchForecast(location);
  if (!forecast?.weather?.length) {
    await ctx.reply(`I couldn't reach the weather service for "${location}". Try again shortly.`);
    return;
  }

  const name = forecast.nearest_area?.[0]?.areaName?.[0]?.value ?? location;
  const lines = forecast.weather.slice(0, 3).map((day) => {
    const midday = day.hourly?.find((h) => h.time === "1200") ?? day.hourly?.[0];
    const desc = midday?.weatherDesc?.[0]?.value?.trim() ?? "—";
    return `${formatDay(day.date)}: ${desc}, ${day.mintempC}–${day.maxtempC}°C`;
  });

  await ctx.reply(`📅 3-day forecast for ${name}\n${lines.join("\n")}`);
};
