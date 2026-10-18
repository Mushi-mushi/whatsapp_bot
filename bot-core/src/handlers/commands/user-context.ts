import type { UserMemoryStore, KnownUser } from "../../state/repos.js";
import type { IncomingMessage } from "../../transport/types.js";
import type { BotConfig } from "../../config/schema.js";
import type { ProfileService } from "../profiles/service.js";
import { normalizeName } from "../../router/normalize.js";
import { memoryKey } from "../../state/identity.js";

const MAX_MSG_LEN = 200;

// Memory belongs to a sender within one stable chat ID, never a display name.
export function senderKey(msg: IncomingMessage): string {
  return memoryKey(chatKey(msg), msg.senderIdentity ?? msg.senderId, msg.senderPhone);
}

export function chatKey(msg: IncomingMessage): string {
  return msg.chatIdentity ?? msg.chatId;
}

// Record a piece of text under the sender's identity and schedule a profile
// refresh, honoring the userMemoryEnabled gate. Shared by bot.ask/tldr/translate
// so command inputs (not just free-form chatter) enrich profiles.
export function rememberMessage(
  store: UserMemoryStore,
  profiler: ProfileService,
  msg: IncomingMessage,
  cfg: BotConfig,
  text: string,
): void {
  if (!cfg.userMemoryEnabled) return;
  const name = msg.senderName?.trim();
  const key = senderKey(msg);
  if (!key || !name || !text.trim()) return;
  store.record(key, name, msg.chatName || null, text, cfg.userMemoryLimit);
  profiler.maybeRefresh(key, name);
}

function sampleLines(store: UserMemoryStore, senderKey: string, limit: number): string[] {
  return store
    .recentFor(senderKey, limit)
    .map((m) => m.message.replace(/\s+/g, " ").trim())
    .filter((m) => m.length > 0)
    .map((m) => (m.length > MAX_MSG_LEN ? `${m.slice(0, MAX_MSG_LEN)}…` : m));
}

// A short "About <name>" block built from an identity's recent messages, or null
// if the bot has never heard from them.
export function userContextBlock(
  store: UserMemoryStore,
  senderKey: string,
  displayName: string,
  limit: number,
  role: string,
): string | null {
  const lines = sampleLines(store, senderKey, limit);
  if (lines.length === 0) return null;
  const header = `About ${displayName}${role ? ` (${role})` : ""}, based on things they have said before:`;
  return `${header}\n${lines.map((l) => `- "${l}"`).join("\n")}`;
}

// Scan the prompt for any other known user's name so the bot can pull in context
// about people the asker is talking about. Resolves each matched name back to its
// stable identity. Returns at most `max` users, excluding the asker's own key.
export function mentionedUsers(
  store: UserMemoryStore,
  prompt: string,
  excludeKey: string,
  chatId: string,
  max = 2,
): KnownUser[] {
  const haystack = normalizeName(prompt);
  if (!haystack) return [];
  const excluded = store.canonicalKey(excludeKey);
  const found: KnownUser[] = [];
  const users = store.knownUsers(chatId);
  for (const u of users) {
    if (u.sender_key === excluded || u.name_norm.length < 3) continue;
    if (users.some((other) => other.sender_key !== u.sender_key && other.name_norm === u.name_norm)) continue;
    // Word-ish boundary match to avoid matching short names inside other words.
    const re = new RegExp(`(?:^|\\W)${escapeRegExp(u.name_norm)}(?:\\W|$)`);
    if (re.test(haystack)) {
      found.push(u);
      if (found.length >= max) break;
    }
  }
  return found;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
