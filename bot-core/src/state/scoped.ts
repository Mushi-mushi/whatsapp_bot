import type Database from "better-sqlite3";
import { IdentityResolver } from "./identity.js";

export interface PersonScope { chat_id: string; sender_id: string }

export function identitiesFor(db: Database.Database): IdentityResolver {
  const identities = new IdentityResolver();
  const rows = db.prepare("SELECT jid, phone FROM contacts WHERE phone IS NOT NULL").all() as { jid: string; phone: string }[];
  for (const row of rows) identities.associate(row.jid, row.phone);
  return identities;
}

export function canonicalScope(identities: IdentityResolver, chatId: string, senderId: string): PersonScope {
  return { chat_id: identities.canonical(chatId), sender_id: identities.canonical(senderId) };
}

export function inChat<T extends { chat_id: string }>(rows: T[], chatId: string, identities: IdentityResolver): T[] {
  const chat = identities.canonical(chatId);
  return rows.filter((r) => identities.canonical(r.chat_id) === chat);
}

export function forPerson<T extends PersonScope>(
  rows: T[], chatId: string, senderId: string, identities: IdentityResolver,
): T[] {
  const person = identities.canonical(senderId);
  return inChat(rows, chatId, identities).filter((r) => identities.canonical(r.sender_id) === person);
}
