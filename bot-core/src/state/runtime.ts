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
  categoryId?: number; // opentdb category id the session is locked to
  categoryName?: string;
  timer?: ReturnType<typeof setTimeout>;
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
  queue: TriviaQuestion[];
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

  isSleeping(): boolean {
    return this.siestaUntil != null && Date.now() < this.siestaUntil;
  }
}
