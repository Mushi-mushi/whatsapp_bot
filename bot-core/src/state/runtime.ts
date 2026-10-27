// Ephemeral, in-memory runtime state (siesta, torture sessions, insult duels).
// Not persisted — these are short-lived and reset on restart by design.

export interface InsultGame {
  targetSender: string;
  targetId: string;
  currentInsultIndex: number | null;
  playerWins: number;
  botWins: number;
  totalRounds: number;
  usedIndices: Set<number>;
  lastInteraction: number;
}

export interface TriviaGame {
  question: string;
  options: string[]; // labeled A..D order shown to the chat
  correct: string; // correct answer text
  askedAt: number;
  language: "en" | "es";
  categoryId?: number; // opentdb category id the session is locked to
  categoryName?: string;
  timer?: ReturnType<typeof setTimeout>;
  // "classic" awards every correct answerer; "duel" is a race (first correct only).
  mode: "classic" | "duel";
  // Person IDs whose question attempt is used: correct in classic, any guess in duels.
  answered: Set<string>;
  // Classic collection window: once the first correct answer lands, this timer
  // closes the question so stragglers can still score before it advances.
  closeTimer?: ReturnType<typeof setTimeout>;
}

export interface TriviaQuestion {
  question: string;
  correct: string;
  options: string[];
  categoryId?: number;
}

// A running trivia session: an opentdb token (guarantees no repeats until
// exhausted) + a locked category + a prefetched queue of questions.
export interface TriviaSession {
  token: string | null;
  category?: { id: number; name: string };
  language: "en" | "es";
  queue: TriviaQuestion[];
}

export interface DuelPlayer {
  name: string;
  score: number;
  trailed?: boolean;
}

// A trivia duel: a bounded "first to target correct answers" race with a join
// lobby. Lives in runtime.triviaDuels; the active question (when running) is the
// matching runtime.triviaGames entry with mode:"duel".
export interface TriviaDuel {
  target: number;
  phase: "lobby" | "running";
  hostName: string;
  players: Map<string, DuelPlayer>; // person ID -> player
  session: TriviaSession;
  category?: { id: number; name: string };
  language: "en" | "es";
  lobbyTimer?: ReturnType<typeof setTimeout>;
  countdownTimers: ReturnType<typeof setTimeout>[];
}

export class RuntimeState {
  private triviaTimers = new Map<string, Set<ReturnType<typeof setTimeout>>>();
  private disposed = false;
  triviaBanUntil: (chatId: string, categoryId: number) => number | null = () => null;

  constructor(private readonly onError: (error: unknown, chatId: string) => void =
    (error, chatId) => console.error("Trivia scheduled work failed", { error, chatId })) {}

  get isDisposed(): boolean {
    return this.disposed;
  }

  scheduleTrivia(chatId: string, run: () => void | Promise<unknown>, delay: number): ReturnType<typeof setTimeout> {
    if (this.disposed) throw new Error("Runtime is shutting down");
    const timers = this.triviaTimers.get(chatId) ?? new Set<ReturnType<typeof setTimeout>>();
    const session = this.triviaSessions.get(chatId);
    const duel = this.triviaDuels.get(chatId);
    this.triviaTimers.set(chatId, timers);
    const timer = setTimeout(() => {
      timers.delete(timer);
      if (this.triviaTimers.get(chatId) === timers && timers.size === 0) this.triviaTimers.delete(chatId);
      if (this.disposed) return;
      void Promise.resolve().then(() => {
        if (!this.disposed) return run();
      }).catch((error: unknown) => {
        if (this.triviaSessions.get(chatId) === session && this.triviaDuels.get(chatId) === duel) {
          this.cancelTrivia(chatId);
        }
        this.onError(error, chatId);
      });
    }, delay);
    timers.add(timer);
    return timer;
  }

  cancelTriviaTimer(chatId: string, timer: ReturnType<typeof setTimeout> | undefined): void {
    clearTimeout(timer);
    if (timer === undefined) return;
    const timers = this.triviaTimers.get(chatId);
    timers?.delete(timer);
    if (timers?.size === 0) this.triviaTimers.delete(chatId);
  }

  cancelTrivia(chatId: string): void {
    for (const timer of this.triviaTimers.get(chatId) ?? []) clearTimeout(timer);
    this.triviaTimers.delete(chatId);
    const game = this.triviaGames.get(chatId);
    clearTimeout(game?.timer);
    clearTimeout(game?.closeTimer);
    const duel = this.triviaDuels.get(chatId);
    clearTimeout(duel?.lobbyTimer);
    for (const timer of duel?.countdownTimers ?? []) clearTimeout(timer);
    this.triviaGames.delete(chatId);
    this.triviaSessions.delete(chatId);
    this.triviaDuels.delete(chatId);
  }

  // Global siesta: while set and in the future, the bot ignores messages.
  siestaUntil: number | null = null;
  siestaChatId: string | null = null;

  // Active torture sessions and their timers, keyed by chat JID.
  tortureTimers = new Map<string, ReturnType<typeof setInterval>>();
  // Cooldown timestamp (ms) before a chat may start torture again.
  tortureCooldownUntil = new Map<string, number>();

  // Active insult duels, keyed by chat JID.
  insultGames = new Map<string, InsultGame>();

  // Active trivia questions awaiting an answer, keyed by chat JID.
  triviaGames = new Map<string, TriviaGame>();

  // Running trivia sessions (token + category + prefetched queue), keyed by chat JID.
  triviaSessions = new Map<string, TriviaSession>();

  // Active trivia duels (lobby or running), keyed by chat JID.
  triviaDuels = new Map<string, TriviaDuel>();

  dispose(): void {
    this.disposed = true;
    for (const chatId of new Set([
      ...this.triviaTimers.keys(), ...this.triviaGames.keys(),
      ...this.triviaSessions.keys(), ...this.triviaDuels.keys(),
    ])) this.cancelTrivia(chatId);
    for (const timer of this.tortureTimers.values()) clearInterval(timer);
    this.tortureTimers.clear();
    this.tortureCooldownUntil.clear();
    this.insultGames.clear();
  }

  isSleeping(): boolean {
    return this.siestaUntil != null && Date.now() < this.siestaUntil;
  }

  cancelSiesta(): boolean {
    const wasSleeping = this.isSleeping();
    this.siestaUntil = null;
    this.siestaChatId = null;
    return wasSleeping;
  }
}
