import type { Handler } from "../../router/router.js";

async function fromIcanhazdadjoke(): Promise<string | null> {
  try {
    const res = await fetch("https://icanhazdadjoke.com/", {
      headers: { Accept: "application/json", "User-Agent": "whatsapp-bot (jokes)" },
      signal: AbortSignal.timeout(8000),
    });
    if (res.ok) {
      const data = (await res.json()) as { joke?: string };
      return data.joke?.trim() || null;
    }
  } catch {
    /* fall through */
  }
  return null;
}

async function fromOfficialJokeApi(): Promise<string | null> {
  try {
    const res = await fetch("https://official-joke-api.appspot.com/random_joke", {
      signal: AbortSignal.timeout(8000),
    });
    if (res.ok) {
      const data = (await res.json()) as { setup?: string; punchline?: string };
      if (data.setup && data.punchline) return `${data.setup}\n${data.punchline}`;
    }
  } catch {
    /* fall through */
  }
  return null;
}

export const jokes: Handler = async (ctx) => {
  const joke = (await fromIcanhazdadjoke()) ?? (await fromOfficialJokeApi());
  await ctx.reply(joke ? `😂 ${joke}` : "I reached for a joke but the internet ghosted me. Try again in a moment!");
};
