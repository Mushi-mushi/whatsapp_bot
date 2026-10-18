import type { Handler } from "../../router/router.js";
import type { BotConfig } from "../../config/schema.js";
import type { RuntimeState, TriviaGame, TriviaSession, TriviaDuel } from "../../state/runtime.js";
import type { TriviaScoreStore, DuelWinStore } from "../../state/repos.js";
import { normalizeName } from "../../router/normalize.js";
import { decodeEntities } from "../../util/net.js";
import { ollamaChat } from "../../util/ollama.js";

const LABELS = ["A", "B", "C", "D", "E", "F"];
const TIMEOUT_MS = 90_000;
// Short pause between a finished question and the next one. During this gap no
// question is active, so a lagged answer to the previous question is dropped
// instead of being judged against the next one.
const NEXT_QUESTION_DELAY_MS = 1200;
// Classic multi-correct: once the first correct answer lands, keep the question
// open this long so other players can still answer it for a point. Kept short so
// latecomers can't just copy the first answer.
const CLASSIC_COLLECT_MS = 3000;
// Ignore answers sent (phone clock) this far before the current question appeared
// — WhatsApp lag can surface a late answer to an already-answered/skipped question.
const STALE_ANSWER_GRACE_MS = 1500;
// Duel (race) tuning.
const DUEL_TARGET_MIN = 5;
const DUEL_TARGET_MAX = 20;
const DUEL_TARGET_DEFAULT = 10;
const DUEL_LOBBY_MS = 30_000;
const DUEL_QUESTION_TIMEOUT_MS = 45_000;
const OPENTDB = "https://opentdb.com";
const BATCH = 20;
type TriviaLanguage = "en" | "es";

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

const LANGUAGES: Record<string, TriviaLanguage> = {
  en: "en",
  english: "en",
  es: "es",
  esp: "es",
  espanol: "es",
  "español": "es",
  spanish: "es",
};

export function resolveCategory(keyword: string): Category | undefined {
  return CATEGORIES[keyword.trim().toLowerCase()];
}

export function categoryKeywordList(): string {
  return [...new Set(Object.keys(CATEGORIES))].sort().join(", ");
}

function resolveLanguage(keyword: string): TriviaLanguage | undefined {
  return LANGUAGES[keyword.trim().toLowerCase()];
}

function languageLabel(language: TriviaLanguage): string {
  return language === "es" ? "Español" : "English";
}

interface OpenTdbResult {
  question: string;
  correct_answer: string;
  incorrect_answers: string[];
}

interface TranslatedTrivia {
  question: string;
  options: string[];
  correct: string;
}

function shuffle<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

async function requestToken(): Promise<string | null> {
  try {
    const res = await fetch(`${OPENTDB}/api_token.php?command=request`, {
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { response_code: number; token?: string };
    return data.response_code === 0 ? (data.token ?? null) : null;
  } catch {
    return null;
  }
}

function parseJsonObject(raw: string): unknown {
  const trimmed = raw.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  const body = fenced ? fenced[1].trim() : trimmed;
  return JSON.parse(body);
}

async function translateQuestionToSpanish(
  cfg: BotConfig,
  question: string,
  options: string[],
  correct: string,
): Promise<TranslatedTrivia | null> {
  const correctIndex = options.findIndex((o) => o === correct);
  if (correctIndex < 0) return null;

  const prompt = JSON.stringify({ question, options, correctIndex });
  const r = await ollamaChat(
    cfg,
    [
      {
        role: "system",
        content:
          "You translate trivia from English to Spanish. Return strict JSON only with keys question, options, correctIndex. Preserve options length and order. Keep correctIndex unchanged.",
      },
      { role: "user", content: prompt },
    ],
    { numPredict: 220, timeoutMs: 20_000 },
  );
  if (!r.ok) return null;

  try {
    const data = parseJsonObject(r.content) as {
      question?: unknown;
      options?: unknown;
      correctIndex?: unknown;
    };
    if (typeof data.question !== "string") return null;
    if (!Array.isArray(data.options) || data.options.length !== options.length) return null;
    if (typeof data.correctIndex !== "number") return null;
    const translatedOptions = data.options.map((v) => (typeof v === "string" ? v.trim() : ""));
    if (translatedOptions.some((v) => !v)) return null;
    const idx = Math.trunc(data.correctIndex);
    if (idx < 0 || idx >= translatedOptions.length) return null;
    return {
      question: data.question.trim(),
      options: translatedOptions,
      correct: translatedOptions[idx],
    };
  } catch {
    return null;
  }
}

// Refill a session's queue with a batch of questions. The opentdb token prevents
// repeats server-side; response_code 4 means the token is exhausted (all seen).
async function refillQueue(session: TriviaSession): Promise<boolean> {
  const cat = session.category ? `&category=${session.category.id}` : "";
  const tok = session.token ? `&token=${session.token}` : "";
  try {
    const res = await fetch(`${OPENTDB}/api.php?amount=${BATCH}&type=multiple${cat}${tok}`, {
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return false;
    const data = (await res.json()) as { response_code: number; results: OpenTdbResult[] };
    if (data.response_code === 4 && session.token) {
      // Token exhausted — reset it so questions can repeat, then let the caller retry.
      await fetch(`${OPENTDB}/api_token.php?command=reset&token=${session.token}`, {
        signal: AbortSignal.timeout(8000),
      });
      return false;
    }
    if (data.response_code !== 0 || !data.results?.length) return false;
    for (const q of data.results) {
      const correct = decodeEntities(q.correct_answer);
      session.queue.push({
        question: decodeEntities(q.question),
        correct,
        options: shuffle([correct, ...q.incorrect_answers.map(decodeEntities)]),
      });
    }
    return true;
  } catch {
    return false;
  }
}

function renderQuestion(game: TriviaGame): string {
  const opts = game.options.map((o, i) => `${LABELS[i]}) ${o}`).join("\n");
  return `${game.question}\n${opts}`;
}

// Clear an active game's timeout so it can't fire after the round ends.
function clearTrivia(runtime: RuntimeState, chatId: string, game: TriviaGame): void {
  runtime.cancelTriviaTimer(chatId, game.timer);
  runtime.cancelTriviaTimer(chatId, game.closeTimer);
}

// Pull the next prepared question from a session's queue, refilling from opentdb
// (and translating to Spanish when requested) as needed. Returns null if unavailable.
async function nextPrepared(
  session: TriviaSession,
  cfg: BotConfig,
): Promise<{ question: string; options: string[]; correct: string } | null> {
  if (session.queue.length === 0) {
    // One retry covers a token reset (exhausted) or a transient hiccup.
    if (!(await refillQueue(session)) && !(await refillQueue(session))) return null;
  }
  const q = session.queue.shift()!;
  if (session.language === "es" && cfg.askEnabled) {
    const translated = await translateQuestionToSpanish(cfg, q.question, q.options, q.correct);
    if (translated) return translated;
  }
  return { question: q.question, options: q.options, correct: q.correct };
}

// Take the next prefetched question (refilling from opentdb as needed), arm its
// timeout, and post it. Used to start a session and to continue after a correct
// answer or a skip. Returns false if unavailable.
export async function startQuestion(
  runtime: RuntimeState,
  chatId: string,
  reply: (text: string) => Promise<void>,
  cfg: BotConfig,
  category?: Category,
  language: TriviaLanguage = "en",
): Promise<boolean> {
  if (runtime.isDisposed) return false;
  let session = runtime.triviaSessions.get(chatId);
  if (!session) {
    session = { token: null, category, language, queue: [] };
    runtime.triviaSessions.set(chatId, session);
    session.token = await requestToken();
    if (runtime.triviaSessions.get(chatId) !== session) return false;
  }

  const prepared = await nextPrepared(session, cfg);
  if (runtime.triviaSessions.get(chatId) !== session) return false;
  if (!prepared) {
    runtime.triviaSessions.delete(chatId);
    await reply("Trivia is unavailable right now — try again in a moment.");
    return false;
  }

  const game: TriviaGame = {
    ...prepared,
    askedAt: Date.now(),
    language: session.language,
    categoryId: session.category?.id,
    categoryName: session.category?.name,
    mode: "classic",
    answered: new Set(),
  };
  // Expire the session if nobody answers correctly in time.
  game.timer = runtime.scheduleTrivia(chatId, async () => {
    if (runtime.triviaGames.get(chatId) === game) {
      runtime.triviaGames.delete(chatId);
      runtime.triviaSessions.delete(chatId);
      await reply(`⏰ Time's up! The answer was "${game.correct}". Trivia ended — \`bot.trivia\` to play again.`);
    }
  }, TIMEOUT_MS);
  runtime.triviaGames.set(chatId, game);
  try {
    await reply(renderQuestion(game));
  } catch (error) {
    if (runtime.triviaGames.get(chatId) === game) runtime.cancelTrivia(chatId);
    throw error;
  }
  return true;
}

// Post the next question after a short gap (see NEXT_QUESTION_DELAY_MS). Scheduled
// off the handler so messages arriving in the gap see no active game and are
// dropped. Skips if the session was stopped (or restarted) during the gap.
export function scheduleNextQuestion(
  runtime: RuntimeState,
  chatId: string,
  reply: (text: string) => Promise<void>,
  cfg: BotConfig,
  category?: Category,
  language: TriviaLanguage = "en",
): void {
  const session = runtime.triviaSessions.get(chatId);
  if (!session || runtime.isDisposed) return;
  runtime.scheduleTrivia(chatId, async () => {
    // A stop/restart during the gap replaces or clears the session — don't revive it.
    if (runtime.triviaSessions.get(chatId) !== session) return;
    await startQuestion(runtime, chatId, reply, cfg, category, language);
  }, NEXT_QUESTION_DELAY_MS);
}

// ---------------------------------------------------------------------------
// Duel mode: a bounded "first to N correct" race with a join lobby. Only the
// fastest correct answer scores each question (speed matters); no wrong penalty.
// ---------------------------------------------------------------------------

function duelStandings(duel: TriviaDuel): string {
  return [...duel.players.values()]
    .sort((a, b) => b.score - a.score)
    .map((p) => `${p.name} ${p.score}/${duel.target}`)
    .join(" · ");
}

// Tear down a duel (any phase) and its active question + timers.
export function endDuel(runtime: RuntimeState, chatId: string): void {
  runtime.cancelTrivia(chatId);
}

// Post the next duel question (refilling the duel's own session). Ends the duel
// if questions are unavailable.
export async function startDuelQuestion(
  runtime: RuntimeState,
  chatId: string,
  reply: (text: string) => Promise<void>,
  cfg: BotConfig,
  duel: TriviaDuel,
): Promise<boolean> {
  const prepared = await nextPrepared(duel.session, cfg);
  if (runtime.isDisposed || runtime.triviaDuels.get(chatId) !== duel) return false;
  if (!prepared) {
    endDuel(runtime, chatId);
    await reply("Trivia is unavailable right now — the duel can't continue. Try again later.");
    return false;
  }
  const game: TriviaGame = {
    ...prepared,
    askedAt: Date.now(),
    language: duel.language,
    categoryId: duel.category?.id,
    categoryName: duel.category?.name,
    mode: "duel",
    answered: new Set(),
  };
  // Nobody answered in time → reveal and move on (the duel continues).
  game.timer = runtime.scheduleTrivia(chatId, async () => {
    if (runtime.triviaGames.get(chatId) !== game) return;
    runtime.triviaGames.delete(chatId);
    await reply(`⏰ Nobody got it — the answer was "${game.correct}". Next up…`);
    if (runtime.triviaDuels.get(chatId) === duel) scheduleNextDuelQuestion(runtime, chatId, reply, cfg);
  }, DUEL_QUESTION_TIMEOUT_MS);
  runtime.triviaGames.set(chatId, game);
  try {
    await reply(renderQuestion(game));
  } catch (error) {
    if (runtime.triviaGames.get(chatId) === game) runtime.cancelTrivia(chatId);
    throw error;
  }
  return true;
}

// Post the next duel question after the inter-question gap (see scheduleNextQuestion).
export function scheduleNextDuelQuestion(
  runtime: RuntimeState,
  chatId: string,
  reply: (text: string) => Promise<void>,
  cfg: BotConfig,
): void {
  const duel = runtime.triviaDuels.get(chatId);
  if (!duel || runtime.isDisposed) return;
  runtime.scheduleTrivia(chatId, async () => {
    const d = runtime.triviaDuels.get(chatId);
    if (!d || d !== duel || d.phase !== "running") return; // stopped during the gap
    await startDuelQuestion(runtime, chatId, reply, cfg, d);
  }, NEXT_QUESTION_DELAY_MS);
}

// Close the lobby and start the race (or cancel if too few joined). Runs a short
// 5→0 countdown, then posts the first question.
export async function beginDuel(
  runtime: RuntimeState,
  chatId: string,
  reply: (text: string) => Promise<void>,
  cfg: BotConfig,
): Promise<void> {
  const duel = runtime.triviaDuels.get(chatId);
  if (!duel || duel.phase !== "lobby") return;
  if (duel.players.size < 2) {
    runtime.triviaDuels.delete(chatId);
    await reply("⌛ Not enough players joined — duel cancelled. Start again with `bot.trivia duel`.");
    return;
  }
  duel.phase = "running";
  await reply(
    `🏁 Duel on! First to ${duel.target}. Players: ${[...duel.players.values()].map((p) => p.name).join(", ")}`,
  );
  if (runtime.triviaDuels.get(chatId) !== duel) return;
  for (const [ms, msg] of [
    [0, "5…"],
    [2000, "3…"],
    [4000, "1…"],
  ] as const) {
    duel.countdownTimers.push(runtime.scheduleTrivia(chatId, () => reply(msg), ms));
  }
  duel.countdownTimers.push(
    runtime.scheduleTrivia(chatId, async () => {
      if (runtime.triviaDuels.get(chatId) !== duel || duel.phase !== "running") return;
      await reply("GO! 🏁");
      if (runtime.triviaDuels.get(chatId) === duel) await startDuelQuestion(runtime, chatId, reply, cfg, duel);
    }, 5000),
  );
}

// ---------------------------------------------------------------------------
// Answer handling (shared by classic + duel), dispatched from the fallback.
// ---------------------------------------------------------------------------

export interface TriviaAnswerCtx {
  runtime: RuntimeState;
  scores: TriviaScoreStore;
  duelScores: DuelWinStore;
  chatId: string;
  senderName: string;
  text: string;
  sentAt: number; // phone send-time (ms) of the answer, for the stale guard
  cfg: BotConfig;
  reply: (text: string) => Promise<void>;
}

// Judge an incoming message against the chat's active question. Returns true if it
// was consumed as a trivia answer (so the fallback stops), false to let other
// handlers run (not an answer, stale, or a non-participant in a duel).
export async function handleTriviaAnswer(c: TriviaAnswerCtx): Promise<boolean> {
  const { runtime, chatId } = c;
  const game = runtime.triviaGames.get(chatId);
  if (!game) return false;
  // Ignore answers sent before this question appeared (lag / already-answered / skipped).
  if (c.sentAt > 0 && c.sentAt < game.askedAt - STALE_ANSWER_GRACE_MS) return false;

  const nameNorm = normalizeName(c.senderName);
  if (game.mode === "duel") return handleDuelAttempt(c, game, nameNorm);

  // Classic: wrong guesses may retry; every correct answerer scores once.
  if (game.answered.has(nameNorm)) return true;
  const result = checkTriviaAnswer(game, c.text);
  if (!result) return false;
  if (result.correct) {
    game.answered.add(nameNorm);
    const points = c.scores.add(chatId, nameNorm, c.senderName, 1);
    await c.reply(`✅ Correct, ${c.senderName}! (+1 → ${points})`);
    if (runtime.triviaGames.get(chatId) !== game) return true;
    // First correct answer opens a short window so stragglers can still score.
    if (!game.closeTimer) {
      runtime.cancelTriviaTimer(chatId, game.timer);
      const category = game.categoryId
        ? { id: game.categoryId, name: game.categoryName ?? "" }
        : undefined;
      game.closeTimer = runtime.scheduleTrivia(chatId, async () => {
        if (runtime.triviaGames.get(chatId) !== game) return;
        runtime.triviaGames.delete(chatId);
        const session = runtime.triviaSessions.get(chatId);
        await c.reply(`⏱️ The answer was "${game.correct}". Next up…`);
        if (runtime.triviaSessions.get(chatId) === session) scheduleNextQuestion(runtime, chatId, c.reply, c.cfg, category, game.language);
      }, CLASSIC_COLLECT_MS);
    }
  } else {
    const points = c.scores.add(chatId, nameNorm, c.senderName, -1);
    await c.reply(`❌ Not that one, ${c.senderName} — that's -1 (now ${points}).`);
  }
  return true;
}

async function handleDuelAttempt(
  c: TriviaAnswerCtx,
  game: TriviaGame,
  nameNorm: string,
): Promise<boolean> {
  const duel = c.runtime.triviaDuels.get(c.chatId);
  if (!duel || duel.phase !== "running") return false;
  const player = duel.players.get(nameNorm);
  if (!player) return false; // not a participant — let other handlers run
  if (game.answered.has(nameNorm)) return true; // one shot per question (no brute force)
  const result = checkTriviaAnswer(game, c.text);
  if (!result) return false;
  game.answered.add(nameNorm);
  if (!result.correct) return true; // no penalty, consumed silently

  // Fastest correct answer takes the question.
  player.score += 1;
  c.runtime.cancelTriviaTimer(c.chatId, game.timer);
  c.runtime.triviaGames.delete(c.chatId);
  if (player.score >= duel.target) {
    const wins = c.duelScores.add(c.chatId, nameNorm, player.name);
    await c.reply(
      `🏆 ${player.name} wins the duel! (${player.score}/${duel.target})\n` +
        `Final: ${duelStandings(duel)}\n` +
        `${player.name} now has ${wins} duel win${wins === 1 ? "" : "s"} this month.`,
    );
    endDuel(c.runtime, c.chatId);
    return true;
  }
  await c.reply(`✅ ${player.name} takes it — ${player.score}/${duel.target}. Next up…\n${duelStandings(duel)}`);
  scheduleNextDuelQuestion(c.runtime, c.chatId, c.reply, c.cfg);
  return true;
}

export function makeTrivia(
  runtime: RuntimeState,
  scores: TriviaScoreStore,
  duelScores: DuelWinStore,
): Handler {
  return async (ctx) => {
    const chatId = ctx.msg.chatId;
    const sub = ctx.args.trim().toLowerCase();
    const reply = (t: string) => ctx.reply(t);
    const active = runtime.triviaGames.get(chatId);

    if (sub === "help" || sub === "commands" || sub === "?") {
      await ctx.reply(
        "🧩 *Trivia help*\n" +
          "• `bot.trivia` — start a quiz (everyone who answers right scores)\n" +
          "• `bot.trivia <category>` — e.g. `bot.trivia science` (`bot.trivia categories` to list)\n" +
          "• add `es` for Spanish, e.g. `bot.trivia film es`\n" +
          "• `bot.trivia skip` / `bot.trivia stop`\n" +
          `• \`bot.trivia duel [${DUEL_TARGET_MIN}-${DUEL_TARGET_MAX}]\` — race mode; others join with \`bot.trivia accept\`\n` +
          "• `bot.trivia scores` · `bot.trivia alltime` · `bot.trivia trophies` · `bot.trivia duels`",
      );
      return;
    }

    if (sub === "scores" || sub === "score" || sub === "leaderboard") {
      const top = scores.top(chatId);
      const trophies = new Map(scores.trophies(chatId, 100).map((t) => [t.name.toLowerCase(), t.trophies]));
      const totals = new Map(scores.allTime(chatId, 100).map((t) => [t.name.toLowerCase(), t.total]));
      await ctx.reply(
        top.length
          ? "🏆 Trivia leaderboard (this month):\n" +
              top
                .map((r, i) => {
                  const n = trophies.get(r.name.toLowerCase()) ?? 0;
                  const total = totals.get(r.name.toLowerCase()) ?? r.correct;
                  return `${i + 1}. ${r.name}: ${r.correct} (all-time ${total})${n ? ` ${"🏆".repeat(Math.min(n, 5))}${n > 5 ? `x${n}` : ""}` : ""}`;
                })
                .join("\n")
          : "No trivia scores here yet this month. Play with `bot.trivia`!",
      );
      return;
    }

    if (sub === "alltime" || sub === "all-time" || sub === "overall") {
      const top = scores.allTime(chatId);
      await ctx.reply(
        top.length
          ? "🌟 All-time trivia leaderboard:\n" + top.map((r, i) => `${i + 1}. ${r.name}: ${r.total}`).join("\n")
          : "No trivia scores here yet. Play with `bot.trivia`!",
      );
      return;
    }

    if (sub === "trophies" || sub === "winners" || sub === "hall") {
      const history = scores.history(chatId);
      await ctx.reply(
        history.length
          ? "🏆 Monthly trivia winners:\n" +
              history.map((h) => `${h.period}: ${h.name} (${h.score})`).join("\n")
          : "No monthly winners yet — the first trophy is awarded when the month ends.",
      );
      return;
    }

    if (sub === "duels" || sub === "duelstats" || sub === "duelscores") {
      const top = duelScores.top(chatId);
      const trophies = new Map(duelScores.trophies(chatId, 100).map((t) => [t.name.toLowerCase(), t.trophies]));
      const totals = new Map(duelScores.allTime(chatId, 100).map((t) => [t.name.toLowerCase(), t.total]));
      await ctx.reply(
        top.length
          ? "⚔️ Duel wins (this month):\n" +
              top
                .map((r, i) => {
                  const n = trophies.get(r.name.toLowerCase()) ?? 0;
                  const total = totals.get(r.name.toLowerCase()) ?? r.wins;
                  return `${i + 1}. ${r.name}: ${r.wins} (all-time ${total})${n ? ` ${"🏆".repeat(Math.min(n, 5))}${n > 5 ? `x${n}` : ""}` : ""}`;
                })
                .join("\n")
          : "No duels won here yet this month. Start one with `bot.trivia duel`!",
      );
      return;
    }

    if (sub === "accept" || sub === "join") {
      const duel = runtime.triviaDuels.get(chatId);
      if (!duel || duel.phase !== "lobby") {
        await ctx.reply("No duel is forming here right now. Start one with `bot.trivia duel`.");
        return;
      }
      const nameNorm = normalizeName(ctx.msg.senderName);
      if (duel.players.has(nameNorm)) {
        await ctx.reply(`${ctx.msg.senderName}, you're already in the duel.`);
        return;
      }
      duel.players.set(nameNorm, { name: ctx.msg.senderName, score: 0 });
      await ctx.reply(`✋ ${ctx.msg.senderName} joined the duel! (${duel.players.size} players in)`);
      return;
    }

    if (sub === "stop") {
      const duel = runtime.triviaDuels.get(chatId);
      if (duel) {
        endDuel(runtime, chatId);
        await ctx.reply("🛑 Duel cancelled.");
        return;
      }
      if (!active && !runtime.triviaSessions.has(chatId)) {
        await ctx.reply("No trivia running here.");
        return;
      }
      runtime.cancelTrivia(chatId);
      await ctx.reply(active ? `🛑 Trivia stopped — the answer was "${active.correct}".` : "Trivia stopped.");
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
      const language = active.language;
      const session = runtime.triviaSessions.get(chatId);
      const duel = runtime.triviaDuels.get(chatId);
      clearTrivia(runtime, chatId, active);
      runtime.triviaGames.delete(chatId);
      await ctx.reply(`⏭️ Skipped — the answer was "${active.correct}". Next up…`);
      if (active.mode === "duel") {
        if (duel && runtime.triviaDuels.get(chatId) === duel) scheduleNextDuelQuestion(runtime, chatId, reply, ctx.config);
      } else if (session && runtime.triviaSessions.get(chatId) === session) {
        scheduleNextQuestion(runtime, chatId, reply, ctx.config, category, language);
      }
      return;
    }

    if (sub === "categories" || sub === "category") {
      await ctx.reply(
        `🗂️ Trivia categories: ${categoryKeywordList()}.\nStart one with e.g. \`bot.trivia science\`. Language options: \`en\` or \`es\` (e.g. \`bot.trivia science es\`).`,
      );
      return;
    }

    const subParts = sub.split(/\s+/).filter(Boolean);
    if (["duel", "challenge", "race"].includes(subParts[0] ?? "")) {
      if (active || runtime.triviaDuels.has(chatId)) {
        await ctx.reply("A game is already running here — `bot.trivia stop` to end it first.");
        return;
      }
      let target = DUEL_TARGET_DEFAULT;
      let category: Category | undefined;
      let language: TriviaLanguage = "en";
      for (const part of subParts.slice(1)) {
        const n = Number(part);
        if (Number.isInteger(n) && n > 0) {
          target = Math.min(DUEL_TARGET_MAX, Math.max(DUEL_TARGET_MIN, n));
          continue;
        }
        const lang = resolveLanguage(part);
        if (lang) {
          language = lang;
          continue;
        }
        const cat = resolveCategory(part);
        if (cat) {
          category = cat;
          continue;
        }
        await ctx.reply(
          `Unknown duel option "${part}". Usage: \`bot.trivia duel [${DUEL_TARGET_MIN}-${DUEL_TARGET_MAX}] [category] [en|es]\`.`,
        );
        return;
      }
      if (language === "es" && !ctx.config.askEnabled) {
        await ctx.reply("Spanish trivia needs AI features enabled in Settings (used to translate questions).");
        return;
      }
      const hostName = ctx.msg.senderName;
      const duel: TriviaDuel = {
        target,
        phase: "lobby",
        hostName,
        players: new Map([[normalizeName(hostName), { name: hostName, score: 0 }]]),
        session: { token: null, category, language, queue: [] },
        category,
        language,
        countdownTimers: [],
      };
      runtime.triviaDuels.set(chatId, duel);
      duel.session.token = await requestToken();
      if (runtime.triviaDuels.get(chatId) !== duel) return;
      await ctx.reply(
        `⚔️ ${hostName} started a trivia duel — first to ${target}${category ? ` — ${category.name}` : ""} (${languageLabel(language)})!\n` +
          `Type \`bot.trivia accept\` to join. The race starts in ${DUEL_LOBBY_MS / 1000}s (need 2+ players).`,
      );
      if (runtime.triviaDuels.get(chatId) === duel) {
        duel.lobbyTimer = runtime.scheduleTrivia(chatId, () => beginDuel(runtime, chatId, reply, ctx.config), DUEL_LOBBY_MS);
      }
      return;
    }

    if (active) {
      await ctx.reply(`A question is already open here:\n${renderQuestion(active)}`);
      return;
    }
    if (runtime.triviaDuels.has(chatId)) {
      await ctx.reply("A duel is in progress here — `bot.trivia stop` to end it, or `bot.trivia accept` to join.");
      return;
    }

    // An unrecognized argument is treated as a category keyword.
    let category: Category | undefined;
    let language: TriviaLanguage = "en";
    if (sub) {
      const parts = sub.split(/\s+/).filter(Boolean);
      for (const part of parts) {
        const maybeLanguage = resolveLanguage(part);
        if (maybeLanguage) {
          language = maybeLanguage;
          continue;
        }
        const maybeCategory = resolveCategory(part);
        if (maybeCategory) {
          category = maybeCategory;
          continue;
        }
        await ctx.reply(
          `Unknown trivia option "${part}". Use \`bot.trivia categories\`, and language options \`en\` or \`es\` (e.g. \`bot.trivia science es\`).`,
        );
        return;
      }
    }

    if (language === "es" && !ctx.config.askEnabled) {
      await ctx.reply("Spanish trivia needs AI features enabled in Settings (used to translate questions).");
      return;
    }

    await ctx.reply(
      `🧩 Trivia time${category ? ` — ${category.name}` : ""} (${languageLabel(language)})! Reply with the letter or the answer. Every correct answer scores a point. \`bot.trivia stop\` to end, \`bot.trivia skip\` to skip, \`bot.trivia duel [${DUEL_TARGET_MIN}-${DUEL_TARGET_MAX}]\` for a race.`,
    );
    // Fresh session — drop any old token/queue so we start with a new pool.
    runtime.triviaSessions.delete(chatId);
    await startQuestion(runtime, chatId, reply, ctx.config, category, language);
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
