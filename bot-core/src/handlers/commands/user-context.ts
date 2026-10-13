import type { UserMemoryStore, KnownUser } from "../../state/repos.js";
import type { IncomingMessage } from "../../transport/types.js";
import { normalizeName } from "../../router/normalize.js";

const MAX_MSG_LEN = 200;

// Stable per-person identity: the real phone digits when known (unifies the same
// person across a DM @lid and a group), otherwise the raw jid/lid. Never the name.
export function senderKey(msg: IncomingMessage): string {
  return msg.senderPhone || msg.senderId;
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
  max = 2,
): KnownUser[] {
  const haystack = normalizeName(prompt);
  if (!haystack) return [];
  const found: KnownUser[] = [];
  for (const u of store.knownUsers()) {
    if (u.sender_key === excludeKey || u.name_norm.length < 3) continue;
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
