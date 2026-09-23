import type { Contact } from "@whiskeysockets/baileys";

export interface ContactRecord {
  jid: string;
  phone: string | null;
  name: string;
}

const digits = (s: string): string => s.replace(/\D/g, "");

// Best display name for a WhatsApp contact, or null if none is set.
export function contactDisplayName(c: Partial<Contact>): string | null {
  const name = (c.name || c.notify || c.verifiedName || "").trim();
  return name || null;
}

// Owns the contact/name directory and the (bug-prone) DM name-resolution cascade.
// WhatsApp routes modern DMs under an opaque LID, so names must be resolvable by
// phone digits, phone JID, chat id, or the profile pushName — in that order.
export class ContactResolver {
  private byJid = new Map<string, string>();
  private byPhone = new Map<string, string>();
  private hydrated = false;

  // Load the persisted directory once (name resolution across restarts).
  hydrate(load?: () => ContactRecord[]): void {
    if (this.hydrated || !load) return;
    for (const r of load()) {
      if (r.jid && r.name) this.byJid.set(r.jid, r.name);
      if (r.phone) this.byPhone.set(digits(r.phone), r.name);
    }
    this.hydrated = true;
  }

  // Ingest a batch of contacts into the maps. Returns the display names to feed
  // the dashboard picker and the records the caller should persist.
  ingest(contacts: Partial<Contact>[]): { names: string[]; records: ContactRecord[] } {
    const names: string[] = [];
    const records: ContactRecord[] = [];
    for (const c of contacts) {
      const name = contactDisplayName(c);
      if (!c.id || !name) continue;
      const phone = c.id.endsWith("@s.whatsapp.net") ? digits(c.id.split(":")[0]) : null;
      this.byJid.set(c.id, name);
      if (phone) this.byPhone.set(phone, name);
      records.push({ jid: c.id, phone, name });
      // A contact's LID (privacy identity) maps to the same saved name.
      const lid = (c as { lid?: string }).lid;
      if (lid) {
        this.byJid.set(lid, name);
        records.push({ jid: lid, phone, name });
      }
      if (!c.id.endsWith("@g.us")) names.push(name);
    }
    return { names, records };
  }

  nameForJid(jid: string): string | undefined {
    return this.byJid.get(jid);
  }

  nameForPhone(phone: string): string | undefined {
    return phone ? this.byPhone.get(digits(phone)) : undefined;
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
