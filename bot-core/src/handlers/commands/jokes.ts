import type { Handler } from "../../router/router.js";
import { tryJson } from "../../util/http.js";

async function fromIcanhazdadjoke(): Promise<string | null> {
  const data = await tryJson<{ joke?: string }>("https://icanhazdadjoke.com/", {
    headers: { Accept: "application/json", "User-Agent": "whatsapp-bot (jokes)" },
  });
  return data?.joke?.trim() || null;
}

async function fromOfficialJokeApi(): Promise<string | null> {
  const data = await tryJson<{ setup?: string; punchline?: string }>(
    "https://official-joke-api.appspot.com/random_joke",
  );
  if (data?.setup && data.punchline) return `${data.setup}\n${data.punchline}`;
  return null;
}

export const jokes: Handler = async (ctx) => {
  const joke = (await fromIcanhazdadjoke()) ?? (await fromOfficialJokeApi());
  await ctx.reply(joke ? `😂 ${joke}` : "I reached for a joke but the internet ghosted me. Try again in a moment!");
};
