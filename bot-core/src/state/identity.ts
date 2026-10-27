export function phoneFromJid(jid: string): string | undefined {
  return /^(\d+)(?::\d+)?@s\.whatsapp\.net$/.exec(jid)?.[1];
}

export function normalizeJid(jid: string): string {
  if (!jid.trim()) throw new Error("An identity is required");
  return jid.replace(/^(\d+):\d+@(s\.whatsapp\.net|lid)$/, "$1@$2");
}

export function phoneDigits(phone?: string | null): string {
  if (!phone) return "";
  return phoneFromJid(phone) ?? (/^\+?[\d ()-]+$/.test(phone) ? phone.replace(/\D/g, "") : "");
}

export function disciplineKey(senderId: string, phone?: string | null): string {
  const digits = phoneDigits(phone) || phoneFromJid(senderId);
  if (digits) return `${digits}@s.whatsapp.net`;
  return normalizeJid(senderId);
}

// Only protocol-provided PN/LID pairs belong here, never names or LID digits.
export class IdentityResolver {
  private readonly phones = new Map<string, string>();

  associate(jid: string, phone: string): void {
    const alias = normalizeJid(jid);
    const digits = phoneDigits(phone);
    if (!digits || (!phoneFromJid(alias) && !/^\d+@lid$/.test(alias))) {
      throw new Error("Invalid WhatsApp identity association");
    }
    const existing = this.phoneFor(alias);
    if (existing && existing !== digits) throw new Error("Conflicting WhatsApp identity association");
    this.phones.set(alias, digits);
  }

  phoneFor(jid: string): string | undefined {
    return phoneFromJid(jid) ?? this.phones.get(normalizeJid(jid));
  }

  canonical(jid: string): string {
    const phone = this.phoneFor(jid);
    return phone ? `${phone}@s.whatsapp.net` : normalizeJid(jid);
  }

  aliasesFor(jid: string): string[] {
    const phone = this.phoneFor(jid);
    const aliases = new Set([normalizeJid(jid), this.canonical(jid)]);
    if (phone) for (const [alias, value] of this.phones) {
      if (value === phone) aliases.add(alias);
    }
    return [...aliases];
  }
}

export function personKey(senderId: string, phone?: string | null): string {
  const digits = phoneDigits(phone);
  if (digits) return digits;
  const jidPhone = phoneFromJid(senderId);
  if (jidPhone) return jidPhone;
  if (!senderId.trim()) throw new Error("A sender identity is required");
  return normalizeJid(senderId);
}

// JSON tuples keep chat and sender boundaries unambiguous, even for opaque IDs.
export function memoryKey(chatId: string, senderId: string, phone?: string | null): string {
  if (!chatId.trim()) throw new Error("A chat identity is required");
  return JSON.stringify([chatId, personKey(senderId, phone)]);
}

export function memoryTuple(key: string): [string, string] {
  const value: unknown = JSON.parse(key);
  if (!Array.isArray(value) || value.length !== 2) {
    throw new Error("Invalid chat-scoped memory key");
  }
  const [chatId, senderId]: unknown[] = value;
  if (typeof chatId !== "string" || !chatId.trim() ||
      typeof senderId !== "string" || !senderId.trim()) {
    throw new Error("Invalid chat-scoped memory key");
  }
  return [chatId, senderId];
}

export function memoryChat(key: string): string {
  return memoryTuple(key)[0];
}
