import type { IncomingMessage } from "../../transport/types.js";
import { disciplineKey, type SeenActivityStore, type SeenRecord } from "../../state/repos.js";
import { normalizeName } from "../../router/normalize.js";
import { chatKey } from "./user-context.js";

export function messagePerson(msg: IncomingMessage): string {
  return disciplineKey(msg.senderIdentity ?? msg.senderId, msg.senderPhone);
}

export function playerLabel(
  player: { name: string; senderId: string }, players: { name: string; senderId: string }[],
): string {
  return players.some((other) => other.senderId !== player.senderId &&
    normalizeName(other.name) === normalizeName(player.name))
    ? `${player.name} [${player.senderId}]` : player.name;
}

export function localTarget(
  people: SeenActivityStore, msg: IncomingMessage, name: string,
): { person: SeenRecord } | { error: string } {
  const matches = people.resolve(chatKey(msg), name);
  const self = people.canonical(messagePerson(msg));
  if (normalizeName(name) === normalizeName(msg.senderName) && !matches.some((p) => p.sender_id === self)) {
    matches.push({ sender_id: self, name: msg.senderName, last_ts: Date.now(), chat_name: msg.chatName });
  }
  if (matches.length > 1) return { error: `More than one person is called "${name}" in this chat, so I won't guess.` };
  if (!matches.length) return { error: `I haven't seen anyone called "${name}" in this chat yet. Ask them to send a message here first.` };
  return { person: matches[0] };
}
