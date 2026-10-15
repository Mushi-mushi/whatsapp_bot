// Ephemeral, in-memory runtime state (siesta, torture sessions, insult duels).
// Not persisted — these are short-lived and reset on restart by design.

export interface InsultGame {
  targetSender: string;
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
  // name_norm of players whose question attempt is used: correct in classic, any guess in duels.
  answered: Set<string>;
  // Classic collection window: once the first correct answer lands, this timer
  // closes the question so stragglers can still score before it advances.
  closeTimer?: ReturnType<typeof setTimeout>;
}

export interface TriviaQuestion {
  question: string;
  correct: string;
  options: string[];
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
}

// A trivia duel: a bounded "first to target correct answers" race with a join
// lobby. Lives in runtime.triviaDuels; the active question (when running) is the
// matching runtime.triviaGames entry with mode:"duel".
export interface TriviaDuel {
  target: number;
  phase: "lobby" | "running";
  hostName: string;
  players: Map<string, DuelPlayer>; // name_norm -> player
  session: TriviaSession;
  category?: { id: number; name: string };
  language: "en" | "es";
  lobbyTimer?: ReturnType<typeof setTimeout>;
  countdownTimers: ReturnType<typeof setTimeout>[];
}

export class RuntimeState {
  // Global siesta: while set and in the future, the bot ignores messages.
  siestaUntil: number | null = null;

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
    for (const timer of this.tortureTimers.values()) clearInterval(timer);
    for (const game of this.triviaGames.values()) {
      clearTimeout(game.timer);
      clearTimeout(game.closeTimer);
    }
    for (const duel of this.triviaDuels.values()) {
      clearTimeout(duel.lobbyTimer);
      for (const t of duel.countdownTimers) clearTimeout(t);
    }
    this.tortureTimers.clear();
    this.tortureCooldownUntil.clear();
    this.triviaGames.clear();
    this.triviaSessions.clear();
    this.triviaDuels.clear();
    this.insultGames.clear();
  }

  isSleeping(): boolean {
    return this.siestaUntil != null && Date.now() < this.siestaUntil;
  }

  cancelSiesta(): boolean {
    const wasSleeping = this.isSleeping();
    this.siestaUntil = null;
    return wasSleeping;
  }
}
