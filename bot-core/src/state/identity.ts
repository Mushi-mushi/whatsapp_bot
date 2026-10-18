export function personKey(senderId: string, phone?: string | null): string {
  const digits = (phone ?? "").replace(/\D/g, "");
  if (digits) return digits;
  if (senderId.endsWith("@s.whatsapp.net")) return senderId.split("@")[0].split(":")[0];
  if (!senderId.trim()) throw new Error("A sender identity is required");
  return senderId;
}

// JSON tuples keep chat and sender boundaries unambiguous, even for opaque IDs.
export function memoryKey(chatId: string, senderId: string, phone?: string | null): string {
  if (!chatId.trim()) throw new Error("A chat identity is required");
  return JSON.stringify([chatId, personKey(senderId, phone)]);
}

export function memoryChat(key: string): string {
  const value: unknown = JSON.parse(key);
  if (!Array.isArray(value) || value.length !== 2) {
    throw new Error("Invalid chat-scoped memory key");
  }
  const [chatId, senderId]: unknown[] = value;
  if (typeof chatId !== "string" || !chatId.trim() ||
      typeof senderId !== "string" || !senderId.trim()) {
    throw new Error("Invalid chat-scoped memory key");
  }
  return chatId;
}
