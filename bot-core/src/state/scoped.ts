import type Database from "better-sqlite3";
import { IdentityResolver, memoryKey, memoryTuple } from "./identity.js";

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

function personCandidate(person: string): string {
  return /^\d+$/.test(person) ? `${person}@s.whatsapp.net` : person;
}

export function canonicalMemoryKey(key: string, identities: IdentityResolver): string {
  let tuple: [string, string];
  try {
    tuple = memoryTuple(key);
  } catch {
    return key;
  }
  const [chatId, person] = tuple;
  const candidate = personCandidate(person);
  return memoryKey(identities.canonical(chatId), candidate, identities.phoneFor(candidate));
}

export function memoryKeyAliases(key: string, identities: IdentityResolver): string[] {
  let tuple: [string, string];
  try {
    tuple = memoryTuple(key);
  } catch {
    return [key];
  }
  const [chatId, person] = tuple;
  const candidate = personCandidate(person);
  const chats = new Set([chatId, ...identities.aliasesFor(chatId)]);
  const persons = new Set([person, ...identities.aliasesFor(candidate)]);
  const phone = identities.phoneFor(candidate);
  if (phone) persons.add(phone);
  const keys = new Set<string>([key, canonicalMemoryKey(key, identities)]);
  for (const c of chats) for (const p of persons) keys.add(JSON.stringify([c, p]));
  return [...keys];
}
