import type { Logger } from "pino";
import type { BotConfig } from "../../config/schema.js";
import type { UserMemoryStore, UserProfile, UserProfileStore } from "../../state/repos.js";
import type { BackgroundJobs } from "../../router/jobs.js";
import { ollamaChat } from "../../util/ollama.js";

// Need at least a few messages before a profile is worth generating.
const MIN_MESSAGES = 4;
const MAX_MSG_LEN = 220;

export class ProfileQueueError extends Error {
  constructor() {
    super("Profile refresh queue is busy or shutting down. Try again shortly.");
    this.name = "ProfileQueueError";
  }
}

// Builds and maintains the two-tier user profiles. Refreshes run on the shared
// background queue so the (slow, GPU-bound) LLM calls never block message handling
// and never compete with paint/film for the GPU.
export class ProfileService {
  private generations = new Map<string, number>();

  constructor(
    private readonly memory: UserMemoryStore,
    private readonly profiles: UserProfileStore,
    private readonly jobs: BackgroundJobs,
    private readonly getConfig: () => BotConfig,
    private readonly logger: Logger,
  ) {}

  // The compact briefing to inject into bot.ask, or null if none exists yet.
  shortFor(senderKey: string): string | null {
    const p = this.profiles.get(senderKey);
    return p?.short.trim() || null;
  }

  // The full dossier, or null if the bot hasn't profiled this person yet.
  deepFor(senderKey: string): UserProfile | null {
    return this.profiles.get(senderKey) ?? null;
  }

  forget(senderKey: string): void {
    this.generations.set(senderKey, (this.generations.get(senderKey) ?? 0) + 1);
    this.profiles.forget(senderKey);
    this.memory.forget(senderKey);
  }

  requestRefresh(senderKey: string, name: string): Promise<UserProfile | null> {
    const generation = this.generations.get(senderKey) ?? 0;
    return new Promise((resolve, reject) => {
      const accepted = this.jobs.submit(`profile:${senderKey}`, async () => {
        try {
          resolve(generation === (this.generations.get(senderKey) ?? 0)
            ? await this.refresh(senderKey, name) : null);
        } catch (error) {
          reject(error);
          throw error;
        }
      }, 1, "profile");
      if (!accepted) reject(new ProfileQueueError());
    });
  }

  // Called after each recorded message: schedule a background rebuild if the
  // profile is missing/stale. Cheap and idempotent (deduped by sender key).
  maybeRefresh(senderKey: string, name: string): void {
    const cfg = this.getConfig();
    if (!cfg.userMemoryEnabled || !cfg.askEnabled) return;
    if (!this.isStale(senderKey, cfg)) return;
    void this.requestRefresh(senderKey, name).catch((err: unknown) => {
      this.logger.warn({ err, senderKey }, "profile refresh was not completed");
    });
  }

  private isStale(senderKey: string, cfg: BotConfig): boolean {
    const p = this.profiles.get(senderKey);
    if (!p) return this.memory.countSince(senderKey, 0) >= MIN_MESSAGES;
    if (this.memory.countSince(senderKey, p.last_profiled_id) >= cfg.profileRefreshEvery) return true;
    const ageMs = Date.now() - p.updated_at;
    return ageMs >= cfg.profileMaxAgeDays * 24 * 60 * 60 * 1000;
  }

  // Rebuild a user's dossier (merging the existing one with new messages) and its
  // short briefing. Returns the updated profile, or null if there's too little to
  // go on or the LLM was unreachable. Safe to call directly (e.g. bot.profile).
  async refresh(senderKey: string, name: string, cfg = this.getConfig()): Promise<UserProfile | null> {
    if (!cfg.userMemoryEnabled || !cfg.askEnabled) return null;
    const generation = this.generations.get(senderKey) ?? 0;
    const lastProfiledId = this.memory.latestId(senderKey);
    const recent = this.memory.recentFor(senderKey, cfg.profileSampleSize);
    if (recent.length < MIN_MESSAGES) return null;

    const existing = this.profiles.get(senderKey);
    const lines = recent
      .map((m) => m.message.replace(/\s+/g, " ").trim())
      .filter(Boolean)
      .map((m) => `- "${m.length > MAX_MSG_LEN ? `${m.slice(0, MAX_MSG_LEN)}…` : m}"`)
      .join("\n");

    const deepRes = await ollamaChat(
      cfg,
      [
        {
          role: "system",
          content:
            "You maintain an evolving dossier about one participant in a group chat. You are given the PREVIOUS dossier (may be empty) and NEW messages from that person. " +
            "Produce an UPDATED dossier that merges both: keep what is still accurate, integrate new information, and sharpen it. " +
            "Track their interests and hobbies, favourite topics, strong opinions, personality and communication style, typical mood/tone, notable facts, and relationships with people they mention. " +
            "Be concrete and specific, and only state things supported by the messages — never invent. " +
            "Write plain text as concise bullet points under short headings. Keep it under ~1500 characters.",
        },
        {
          role: "user",
          content: `Person: ${name}\n\nPREVIOUS DOSSIER:\n${existing?.deep?.trim() || "(none yet)"}\n\nNEW MESSAGES:\n${lines}`,
        },
      ],
      { numPredict: 600, numCtx: 8192 },
    );
    if (generation !== (this.generations.get(senderKey) ?? 0)) return null;
    if (!deepRes.ok) {
      this.logger.warn({ senderKey, result: deepRes }, "profile generation failed");
      return null;
    }
    const deep = deepRes.content.trim();

    const shortRes = await ollamaChat(
      cfg,
      [
        {
          role: "system",
          content:
            "You compress a personality dossier into a tiny briefing for injection into an AI prompt with a small context window. " +
            `Output at most ${cfg.profileShortMaxChars} characters, plain text, one short paragraph with no preamble or bullet points. ` +
            "Be straight to the point: who they are, their main interests, and their tone.",
        },
        { role: "user", content: `Dossier for ${name}:\n${deep}` },
      ],
      { numPredict: 300 },
    );
    if (generation !== (this.generations.get(senderKey) ?? 0)) return null;
    if (!shortRes.ok) this.logger.warn({ senderKey, result: shortRes }, "profile briefing failed; using dossier excerpt");
    const short = shortRes.ok
      ? shortRes.content.trim().slice(0, cfg.profileShortMaxChars)
      : deep.slice(0, cfg.profileShortMaxChars);

    this.profiles.upsert({
      sender_key: senderKey,
      name,
      deep,
      short,
      last_profiled_id: lastProfiledId,
    });
    this.logger.info({ senderKey, name }, "profile refreshed");
    return this.profiles.get(senderKey) ?? null;
  }
}
