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

  // Questions already asked in the current trivia session, keyed by chat JID
  // (cleared when the session ends, so a new run can repeat them).
  triviaAsked = new Map<string, Set<string>>();

  isSleeping(): boolean {
    return this.siestaUntil != null && Date.now() < this.siestaUntil;
  }
}
