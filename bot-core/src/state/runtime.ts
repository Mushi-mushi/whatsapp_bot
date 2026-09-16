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

export class RuntimeState {
  // Global siesta: while set and in the future, the bot ignores messages.
  siestaUntil: number | null = null;

  // Active torture sessions and their timers, keyed by chat JID.
  tortureTimers = new Map<string, ReturnType<typeof setInterval>>();
  // Cooldown timestamp (ms) before a chat may start torture again.
  tortureCooldownUntil = new Map<string, number>();

  // Active insult duels, keyed by chat JID.
  insultGames = new Map<string, InsultGame>();

  isSleeping(): boolean {
    return this.siestaUntil != null && Date.now() < this.siestaUntil;
  }
}
