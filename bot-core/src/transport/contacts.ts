import type { Contact } from "@whiskeysockets/baileys";
import { IdentityResolver, normalizeJid, phoneDigits, phoneFromJid } from "../state/identity.js";

export interface ContactRecord {
  jid: string;
  phone: string | null;
  name: string;
}

// Best display name for a WhatsApp contact, or null if none is set.
export function contactDisplayName(c: Partial<Contact>): string | null {
  const name = (c.name || c.notify || c.verifiedName || "").trim();
  return name || null;
}

export class ContactResolver extends IdentityResolver {
  private byJid = new Map<string, string>();
  private byPhone = new Map<string, string>();
  private records = new Map<string, ContactRecord>();
  private hydrated = false;

  // Load the persisted directory once (name resolution across restarts).
  hydrate(load?: () => ContactRecord[]): void {
    if (this.hydrated || !load) return;
    for (const r of load()) this.record(r);
    this.hydrated = true;
  }

  clone(): ContactResolver {
    const copy = new ContactResolver();
    copy.hydrate(() => [...this.records.values()]);
    return copy;
  }

  private record(r: ContactRecord): ContactRecord {
    const jid = normalizeJid(r.jid);
    if (r.phone) this.associate(jid, r.phone);
    const phone = this.phoneFor(jid) ?? null;
    const name = r.name.trim() || this.byJid.get(jid) || "";
    const record = { jid, phone, name };
    this.records.set(jid, record);
    if (name) this.byJid.set(jid, name);
    if (phone && name) this.byPhone.set(phone, name);
    return record;
  }

  // Ingest a batch of contacts into the maps. Returns the display names to feed
  // the dashboard picker and the records the caller should persist.
  ingest(contacts: Partial<Contact>[]): { names: string[]; records: ContactRecord[] } {
    const names: string[] = [];
    const records: ContactRecord[] = [];
    for (const c of contacts) {
      const name = contactDisplayName(c);
      if (!c.id) continue;
      const phone = phoneFromJid(c.jid ?? "") ?? phoneFromJid(c.id) ?? this.phoneFor(c.id);
      // Nameless aliases still carry identity information and must survive restart.
      if (!name && !phone) continue;
      for (const jid of new Set([c.id, c.jid, c.lid])) {
        if (jid) records.push(this.record({ jid, phone: phone ?? null, name: name ?? "" }));
      }
      if (name && !c.id.endsWith("@g.us")) names.push(name);
    }
    return { names, records };
  }

  nameForJid(jid: string): string | undefined {
    return this.byJid.get(normalizeJid(jid));
  }

  nameForPhone(phone: string): string | undefined {
    const digits = phoneDigits(phone);
    return digits ? this.nameForJid(`${digits}@s.whatsapp.net`) ?? this.byPhone.get(digits) : undefined;
  }

  // Resolve a DM chat name: saved name by phone, then by phone JID, then by chat
  // id, then the profile pushName, and finally the raw sender id as a last resort.
  resolveDmName(opts: {
    chatId: string;
    phoneJid?: string;
    senderPhone: string;
    pushName?: string | null;
    senderId: string;
  }): string {
    return (
      (opts.senderPhone ? this.nameForPhone(opts.senderPhone) : undefined) ??
      (opts.phoneJid ? this.byJid.get(opts.phoneJid) : undefined) ??
      this.byJid.get(opts.chatId) ??
      opts.pushName ??
      opts.senderId
    );
  }
}
