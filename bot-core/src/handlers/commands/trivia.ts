import type { Handler } from "../../router/router.js";
import type { RuntimeState, TriviaGame } from "../../state/runtime.js";
import type { TriviaScoreStore } from "../../state/repos.js";
import { decodeEntities } from "../../util/net.js";

const LABELS = ["A", "B", "C", "D", "E", "F"];
const TIMEOUT_MS = 90_000;

export interface Category {
  id: number;
  name: string;
}

// Friendly keyword -> Open Trivia DB category. Keywords are matched case-insensitively.
const CATEGORIES: Record<string, Category> = {
  general: { id: 9, name: "General Knowledge" },
  books: { id: 10, name: "Books" },
  film: { id: 11, name: "Film" },
  movies: { id: 11, name: "Film" },
  music: { id: 12, name: "Music" },
  tv: { id: 14, name: "Television" },
  television: { id: 14, name: "Television" },
  games: { id: 15, name: "Video Games" },
  videogames: { id: 15, name: "Video Games" },
  science: { id: 17, name: "Science & Nature" },
  computers: { id: 18, name: "Computers" },
  tech: { id: 18, name: "Computers" },
  maths: { id: 19, name: "Mathematics" },
  math: { id: 19, name: "Mathematics" },
  mythology: { id: 20, name: "Mythology" },
  sports: { id: 21, name: "Sports" },
  geography: { id: 22, name: "Geography" },
  history: { id: 23, name: "History" },
  politics: { id: 24, name: "Politics" },
  art: { id: 25, name: "Art" },
  animals: { id: 27, name: "Animals" },
  vehicles: { id: 28, name: "Vehicles" },
  anime: { id: 31, name: "Anime" },
};

export function resolveCategory(keyword: string): Category | undefined {
  return CATEGORIES[keyword.trim().toLowerCase()];
}

export function categoryKeywordList(): string {
  return [...new Set(Object.keys(CATEGORIES))].sort().join(", ");
}

interface OpenTdbResult {
  question: string;
  correct_answer: string;
  incorrect_answers: string[];
}

function shuffle<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

async function fetchTrivia(category?: Category): Promise<TriviaGame | null> {
  try {
    const url =
      "https://opentdb.com/api.php?amount=1&type=multiple" +
      (category ? `&category=${category.id}` : "");
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return null;
    const data = (await res.json()) as { response_code: number; results: OpenTdbResult[] };
    const q = data.results?.[0];
    if (!q) return null;
    const correct = decodeEntities(q.correct_answer);
    const options = shuffle([correct, ...q.incorrect_answers.map(decodeEntities)]);
    return {
      question: decodeEntities(q.question),
      options,
      correct,
      askedAt: Date.now(),
      categoryId: category?.id,
      categoryName: category?.name,
    };
  } catch {
    return null;
  }
}

function renderQuestion(game: TriviaGame): string {
  const opts = game.options.map((o, i) => `${LABELS[i]}) ${o}`).join("\n");
  return `${game.question}\n${opts}`;
}

// Clear an active game's timeout so it can't fire after the round ends.
export function clearTrivia(game: TriviaGame): void {
  if (game.timer) clearTimeout(game.timer);
}

// Fetch a fresh question, arm its timeout, and post it. Used to start a session
// and to continue after a correct answer or a skip. Returns false if unavailable.
export async function startQuestion(
  runtime: RuntimeState,
  chatId: string,
  reply: (text: string) => Promise<void>,
  category?: Category,
): Promise<boolean> {
  const game = await fetchTrivia(category);
  if (!game) {
    await reply("Trivia is unavailable right now — try again in a moment.");
    return false;
  }
  // Expire the session if nobody answers correctly in time.
  game.timer = setTimeout(() => {
    if (runtime.triviaGames.get(chatId) === game) {
      runtime.triviaGames.delete(chatId);
      void reply(`⏰ Time's up! The answer was "${game.correct}". Trivia ended — \`bot.trivia\` to play again.`);
    }
  }, TIMEOUT_MS);
  runtime.triviaGames.set(chatId, game);
  await reply(renderQuestion(game));
  return true;
}

export function makeTrivia(runtime: RuntimeState, scores: TriviaScoreStore): Handler {
  return async (ctx) => {
    const chatId = ctx.msg.chatId;
    const sub = ctx.args.trim().toLowerCase();
    const reply = (t: string) => ctx.reply(t);
    const active = runtime.triviaGames.get(chatId);

    if (sub === "scores" || sub === "score" || sub === "leaderboard") {
      const top = scores.top(chatId);
      await ctx.reply(
        top.length
          ? "🏆 Trivia leaderboard:\n" +
              top.map((r, i) => `${i + 1}. ${r.name}: ${r.correct}`).join("\n")
          : "No trivia scores here yet. Play with `bot.trivia`!",
      );
      return;
    }

    if (sub === "stop") {
      if (!active) {
        await ctx.reply("No trivia running here.");
        return;
      }
      clearTrivia(active);
      runtime.triviaGames.delete(chatId);
      await ctx.reply(`🛑 Trivia stopped — the answer was "${active.correct}".`);
      return;
    }

    if (sub === "skip" || sub === "next") {
      if (!active) {
        await ctx.reply("No trivia running here. Start with `bot.trivia`.");
        return;
      }
      const category = active.categoryId
        ? { id: active.categoryId, name: active.categoryName ?? "" }
        : undefined;
      clearTrivia(active);
      runtime.triviaGames.delete(chatId);
      await ctx.reply(`⏭️ Skipped — the answer was "${active.correct}". Next up…`);
      await startQuestion(runtime, chatId, reply, category);
      return;
    }

    if (sub === "categories" || sub === "category") {
      await ctx.reply(`🗂️ Trivia categories: ${categoryKeywordList()}.\nStart one with e.g. \`bot.trivia science\`.`);
      return;
    }

    if (active) {
      await ctx.reply(`A question is already open here:\n${renderQuestion(active)}`);
      return;
    }

    // An unrecognized argument is treated as a category keyword.
    let category: Category | undefined;
    if (sub) {
      category = resolveCategory(sub);
      if (!category) {
        await ctx.reply(
          `Unknown category "${sub}". Try \`bot.trivia categories\` to see the list, or just \`bot.trivia\` for a mix.`,
        );
        return;
      }
    }

    await ctx.reply(
      `🧩 Trivia time${category ? ` — ${category.name}` : ""}! Reply with the letter or the answer. A correct answer brings the next question. \`bot.trivia stop\` to end, \`bot.trivia skip\` to skip.`,
    );
    await startQuestion(runtime, chatId, reply, category);
  };
}

// Judge a free-text reply. Returns null if it isn't a recognizable answer attempt,
// otherwise whether it was correct (a wrong attempt keeps the round open).
export function checkTriviaAnswer(game: TriviaGame, text: string): { correct: boolean } | null {
  const guess = text.trim();
  if (!guess) return null;

  const letter = guess.length === 1 ? LABELS.indexOf(guess.toUpperCase()) : -1;
  let chosen: string | null = null;
  if (letter >= 0 && letter < game.options.length) {
    chosen = game.options[letter];
  } else {
    const norm = guess.toLowerCase();
    chosen = game.options.find((o) => o.toLowerCase() === norm) ?? null;
  }
  if (chosen === null) return null;
  return { correct: chosen === game.correct };
}
