import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type { Delivery } from "../state/outbox.js";
import { HOUR, type Pet, type RequestKind, type Species } from "./model.js";
import { DEFAULT_PET_SETTINGS } from "./settings.js";

export interface PetEvent {
  id: string;
  chat_id: string;
  stage: number;
  sleeping: number;
  request_kind: RequestKind | null;
  sent_at: number | null;
  species: Species;
}

export class PetStore {
  constructor(private readonly db: Database.Database) {}

  transaction<T>(run: () => T): T {
    return this.db.transaction(run)();
  }

  get(chatId: string): Pet | undefined {
    const row = this.db.prepare("SELECT state FROM pets WHERE chat_id = ?").get(chatId) as { state: string } | undefined;
    return row ? this.decode(row.state) : undefined;
  }

  all(): Pet[] {
    return (this.db.prepare("SELECT state FROM pets").all() as { state: string }[])
      .map((row) => this.decode(row.state));
  }

  private decode(state: string): Pet {
    const pet = JSON.parse(state) as Pet;
    // Pets created before species existed are the original cloud bird.
    return { ...DEFAULT_PET_SETTINGS, ...pet, species: pet.species ?? "bird",
      hydration: pet.hydration ?? 100, cleanliness: pet.cleanliness ?? 100,
      lastWater: pet.lastWater ?? -HOUR, lastClean: pet.lastClean ?? -HOUR };
  }

  save(pet: Pet): void {
    this.db.prepare("INSERT INTO pets (chat_id, state) VALUES (?, ?) ON CONFLICT(chat_id) DO UPDATE SET state = excluded.state")
      .run(pet.chatId, JSON.stringify(pet));
  }

  enqueue(pet: Pet, body: string, now: number, requestKind: RequestKind | null = null): string {
    const id = randomUUID();
    this.db.prepare("INSERT INTO pet_events (id, chat_id, stage, sleeping, request_kind) VALUES (?, ?, ?, ?, ?)")
      .run(id, pet.chatId, pet.stage, Number(pet.hibernating || requestKind === "silence"), requestKind);
    this.db.prepare("INSERT INTO outbox (chat_id, body, available_at, created_at, pet_event_id) VALUES (?, ?, ?, ?, ?)")
      .run(pet.chatId, body, now, now, id);
    return id;
  }

  event(id: string): PetEvent | undefined {
    const row = this.db.prepare("SELECT * FROM pet_events WHERE id = ?").get(id) as Omit<PetEvent, "species"> | undefined;
    if (!row) return undefined;
    const pet = this.get(row.chat_id);
    if (!pet) throw new Error("Pet event has no pet");
    return { ...row, species: pet.species };
  }

  markSent(id: string, now: number): void {
    this.db.prepare("UPDATE pet_events SET sent_at = ? WHERE id = ?").run(now, id);
  }

  cancel(chatId: string, eventId?: string): void {
    this.db.prepare(`UPDATE outbox SET status = 'cancelled', lease_until = NULL
      WHERE chat_id = ? AND pet_event_id IS NOT NULL AND status IN ('pending', 'sending')
      ${eventId ? "AND pet_event_id = ?" : ""}`)
      .run(...(eventId ? [chatId, eventId] : [chatId]));
  }

  deliveryFailed(eventId: string): boolean {
    const row = this.db.prepare("SELECT status FROM outbox WHERE pet_event_id = ?").get(eventId) as { status: string } | undefined;
    return row?.status === "failed";
  }

  isSending(delivery: Delivery): boolean {
    return !!this.db.prepare("SELECT 1 FROM outbox WHERE id = ? AND claim_token = ? AND status = 'sending'")
      .get(delivery.id, delivery.claim_token);
  }
}
