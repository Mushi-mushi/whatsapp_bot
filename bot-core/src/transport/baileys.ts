import makeWASocket, {
  DisconnectReason,
  downloadMediaMessage,
  fetchLatestBaileysVersion,
  useMultiFileAuthState,
  type Chat,
  type Contact,
  type WAMessage,
  type WAMessageContent,
  type WAMessageKey,
  type WASocket,
} from "@whiskeysockets/baileys";
import type { Logger } from "pino";
import QRCode from "qrcode";
import { rm } from "node:fs/promises";
import type {
  ConnectionStatus,
  IncomingMessage,
  MessageKind,
  Transport,
} from "./types.js";

export interface BaileysOptions {
  authDir: string;
  logger: Logger;
  // If set, request a pairing code for this number instead of QR on first login.
  pairingNumber?: string;
  // Pull full chat/contact history on connect (only fires at fresh link). Off by default.
  syncFullHistory?: boolean;
  // Persist the contact directory (jid/lid -> name/phone) so it survives restarts.
  persistContacts?: (records: { jid: string; phone: string | null; name: string }[]) => void;
  // Load the persisted contact directory on start (name resolution across restarts).
  loadContacts?: () => { jid: string; phone: string | null; name: string }[];
}

export class BaileysTransport implements Transport {
  private sock: WASocket | null = null;
  private status: ConnectionStatus = {
    state: "connecting",
    qrDataUrl: null,
    pairingCode: null,
    me: null,
  };
  private messageCbs: ((m: IncomingMessage) => void)[] = [];
  private statusCbs: ((s: ConnectionStatus) => void)[] = [];
  private chatsCbs: ((names: string[]) => void)[] = [];
  private groupSubjects = new Map<string, string>();
  private contactNames = new Map<string, string>();
  private contactByPhone = new Map<string, string>();
  private contactsHydrated = false;
  private pairingRequested = false;
  private reconnectScheduled = false;
  private consecutiveLogouts = 0;
  // Recently sent/seen message content, so we can answer decryption retry receipts
  // (otherwise the peer is stuck on "Waiting for this message").
  private messageCache = new Map<string, WAMessageContent>();

  constructor(private readonly opts: BaileysOptions) {}

  onMessage(cb: (m: IncomingMessage) => void): void {
    this.messageCbs.push(cb);
  }

  onStatus(cb: (s: ConnectionStatus) => void): void {
    this.statusCbs.push(cb);
  }

  onChatsDiscovered(cb: (names: string[]) => void): void {
    this.chatsCbs.push(cb);
  }

  private emitChats(names: string[]): void {
    const clean = names.map((n) => n.trim()).filter(Boolean);
    if (clean.length) for (const cb of this.chatsCbs) cb(clean);
  }

  getStatus(): ConnectionStatus {
    return this.status;
  }

  private setStatus(patch: Partial<ConnectionStatus>): void {
    this.status = { ...this.status, ...patch };
    for (const cb of this.statusCbs) cb(this.status);
  }

  private async clearAuth(): Promise<void> {
    try {
      await rm(this.opts.authDir, { recursive: true, force: true });
    } catch (err) {
      this.opts.logger.error({ err }, "Failed to clear auth dir");
    }
  }

  // Schedule a single reconnect, coalescing overlapping close events so we never
  // spin up multiple concurrent sockets.
  private scheduleReconnect(delayMs = 2000): void {
    if (this.reconnectScheduled) return;
    this.reconnectScheduled = true;
    setTimeout(() => {
      this.reconnectScheduled = false;
      void this.start();
    }, delayMs);
  }

  async start(): Promise<void> {
    // Hydrate the persisted contact directory once so DM names resolve after restarts.
    if (!this.contactsHydrated && this.opts.loadContacts) {
      for (const r of this.opts.loadContacts()) {
        if (r.jid && r.name) this.contactNames.set(r.jid, r.name);
        if (r.phone) this.contactByPhone.set(r.phone.replace(/\D/g, ""), r.name);
      }
      this.contactsHydrated = true;
    }

    const { state, saveCreds } = await useMultiFileAuthState(this.opts.authDir);
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
      version,
      auth: state,
      logger: this.opts.logger,
      printQRInTerminal: false,
      markOnlineOnConnect: false,
      // Pull recent chats/contacts on connect so DMs populate the picker.
      // History messages arrive via 'messaging-history.set' (not 'messages.upsert'),
      // so they are never processed as commands. Only useful at a fresh link.
      syncFullHistory: this.opts.syncFullHistory ?? false,
      // Serve message content for decryption-retry receipts.
      getMessage: async (key: WAMessageKey) =>
        (key.id ? this.messageCache.get(key.id) : undefined) ?? undefined,
    });
    this.sock = sock;

    // Pairing-code login: request once when not registered and a number was provided.
    if (this.opts.pairingNumber && !sock.authState.creds.registered && !this.pairingRequested) {
      this.pairingRequested = true;
      try {
        const code = await sock.requestPairingCode(this.opts.pairingNumber.replace(/[^0-9]/g, ""));
        this.setStatus({ state: "pairing", pairingCode: code });
      } catch (err) {
        this.opts.logger.error({ err }, "Failed to request pairing code");
      }
    }

    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("connection.update", async (update) => {
      const { connection, lastDisconnect, qr } = update;
      if (qr && !this.opts.pairingNumber) {
        this.setStatus({ state: "qr", qrDataUrl: await QRCode.toDataURL(qr) });
      }
      if (connection === "open") {
        this.consecutiveLogouts = 0;
        this.setStatus({
          state: "open",
          qrDataUrl: null,
          pairingCode: null,
          me: sock.user?.id ?? null,
        });
        void this.prefetchGroups();
      } else if (connection === "close") {
        const statusCode = (lastDisconnect?.error as { output?: { statusCode?: number } } | undefined)
          ?.output?.statusCode;
        const loggedOut = statusCode === DisconnectReason.loggedOut;
        this.setStatus({ state: "close" });
        if (loggedOut) {
          this.consecutiveLogouts += 1;
          // A single 401 is frequently transient (WhatsApp rejecting a rapid
          // reconnect). Retry with existing creds first; only after repeated
          // logouts do we treat the session as dead and clear it for re-pair.
          if (this.consecutiveLogouts >= 3) {
            this.opts.logger.error("Repeated logouts — clearing dead session for re-pair.");
            this.pairingRequested = false;
            this.consecutiveLogouts = 0;
            await this.clearAuth();
          } else {
            this.opts.logger.warn(
              { statusCode, attempt: this.consecutiveLogouts },
              "Logout (likely transient), reconnecting...",
            );
          }
        } else {
          this.opts.logger.warn({ statusCode }, "Connection closed, reconnecting...");
        }
        this.scheduleReconnect();
      }
    });

    sock.ev.on("messages.upsert", async ({ messages, type }) => {
      // "notify" = new incoming message. "append" = a message added to a chat,
      // which is how our OWN messages typed on the phone reach the linked device.
      // Handle both so self-commands work; guard "append" by recency + dedupe so
      // we never re-run old messages pulled in during chat appends.
      if (type !== "notify" && type !== "append") return;
      for (const raw of messages) {
        if (raw.key?.id && raw.message) this.cacheMessage(raw.key.id, raw.message);
        if (type === "append") {
          const ts = Number(raw.messageTimestamp ?? 0) * 1000;
          if (!ts || Date.now() - ts > 120_000) continue;
        }
        const incoming = await this.toIncoming(raw);
        if (incoming) for (const cb of this.messageCbs) cb(incoming);
      }
    });

    // Keep group subjects fresh for the approval guard + dashboard picker.
    sock.ev.on("groups.update", (updates) => {
      for (const g of updates) {
        if (g.id && g.subject) {
          this.groupSubjects.set(g.id, g.subject);
          this.emitChats([g.subject]);
        }
      }
    });

    // Contacts + recent chats sync (populates individual/DM chats in the picker).
    sock.ev.on("messaging-history.set", ({ chats, contacts }) => {
      this.ingestContacts(contacts);
      this.ingestChats(chats);
    });
    sock.ev.on("contacts.upsert", (contacts) => this.ingestContacts(contacts));
    sock.ev.on("contacts.update", (contacts) => this.ingestContacts(contacts));
    sock.ev.on("chats.upsert", (chats) => this.ingestChats(chats));
  }

  private contactDisplayName(c: Partial<Contact>): string | null {
    const name = (c.name || c.notify || c.verifiedName || "").trim();
    return name || null;
  }

  private ingestContacts(contacts: Partial<Contact>[]): void {
    const names: string[] = [];
    const records: { jid: string; phone: string | null; name: string }[] = [];
    for (const c of contacts) {
      const name = this.contactDisplayName(c);
      if (!c.id || !name) continue;
      const phone = c.id.endsWith("@s.whatsapp.net")
        ? c.id.split("@")[0].split(":")[0].replace(/\D/g, "")
        : null;
      this.contactNames.set(c.id, name);
      if (phone) this.contactByPhone.set(phone, name);
      records.push({ jid: c.id, phone, name });
      // A contact's LID (privacy identity) also maps to the same saved name.
      const lid = (c as { lid?: string }).lid;
      if (lid) {
        this.contactNames.set(lid, name);
        records.push({ jid: lid, phone, name });
      }
      if (!c.id.endsWith("@g.us")) names.push(name);
    }
    if (records.length) this.opts.persistContacts?.(records);
    this.emitChats(names);
  }

  private ingestChats(chats: Chat[]): void {
    const names: string[] = [];
    for (const chat of chats) {
      if (!chat.id) continue;
      if (chat.id.endsWith("@g.us")) {
        const subject = chat.name?.trim() || this.groupSubjects.get(chat.id);
        if (subject) {
          this.groupSubjects.set(chat.id, subject);
          names.push(subject);
        }
      } else {
        const name = this.contactNames.get(chat.id) || chat.name?.trim();
        if (name) names.push(name);
      }
    }
    this.emitChats(names);
  }

  private async prefetchGroups(): Promise<void> {
    try {
      const groups = await this.sock!.groupFetchAllParticipating();
      const names: string[] = [];
      for (const g of Object.values(groups)) {
        if (g.id && g.subject) {
          this.groupSubjects.set(g.id, g.subject);
          names.push(g.subject);
        }
      }
      this.emitChats(names);
    } catch (err) {
      this.opts.logger.warn({ err }, "Failed to prefetch group subjects");
    }
  }

  private async resolveGroupSubject(jid: string): Promise<string> {
    const cached = this.groupSubjects.get(jid);
    if (cached) return cached;
    try {
      const meta = await this.sock!.groupMetadata(jid);
      this.groupSubjects.set(jid, meta.subject);
      this.emitChats([meta.subject]);
      return meta.subject;
    } catch {
      return jid;
    }
  }

  private async toIncoming(raw: WAMessage): Promise<IncomingMessage | null> {
    if (!raw.message || !raw.key?.remoteJid) return null;
    const chatId = raw.key.remoteJid;
    const isGroup = chatId.endsWith("@g.us");
    const fromMe = !!raw.key.fromMe;
    const senderId = isGroup ? raw.key.participant ?? chatId : chatId;

    // WhatsApp now routes DMs under an opaque LID; the real phone JID (when the
    // chat id is a @lid) arrives in senderPn / participantPn.
    const key = raw.key as { senderPn?: string; participantPn?: string };
    const phoneJid = (isGroup ? key.participantPn : key.senderPn) ?? undefined;
    const phoneSource = phoneJid ?? (senderId.endsWith("@s.whatsapp.net") ? senderId : "");
    const senderPhone = phoneSource.split("@")[0].split(":")[0].replace(/\D/g, "");

    const m = raw.message;
    let kind: MessageKind = "other";
    let text: string | null = null;

    if (m.conversation) {
      kind = "text";
      text = m.conversation;
    } else if (m.extendedTextMessage?.text) {
      kind = "text";
      text = m.extendedTextMessage.text;
    } else if (m.audioMessage) {
      kind = "audio";
    } else if (m.imageMessage) {
      kind = "image";
      text = m.imageMessage.caption ?? null;
    } else if (m.videoMessage) {
      kind = "video";
      text = m.videoMessage.caption ?? null;
    } else if (m.stickerMessage) {
      kind = "sticker";
    }

    // The "chat" is the group (by subject) or the DM contact. Prefer the saved
    // address-book name looked up by PHONE first: a contact's LID may carry only
    // the profile name, so phone-based lookup wins for the real saved name.
    const chatName = isGroup
      ? await this.resolveGroupSubject(chatId)
      : (senderPhone ? this.contactByPhone.get(senderPhone) : undefined) ??
        (phoneJid ? this.contactNames.get(phoneJid) : undefined) ??
        this.contactNames.get(chatId) ??
        raw.pushName ??
        senderId;

    return {
      chatId,
      chatName,
      senderId,
      senderName: raw.pushName ?? senderId,
      senderPhone,
      messageId: raw.key.id ?? "",
      fromMe,
      isGroup,
      text,
      kind,
      timestamp: Number(raw.messageTimestamp ?? 0) * 1000,
      raw,
    };
  }

  async sendText(chatId: string, text: string): Promise<void> {
    if (!this.sock) throw new Error("Transport not started");
    const sent = await this.sock.sendMessage(chatId, { text });
    if (sent?.key?.id && sent.message) this.cacheMessage(sent.key.id, sent.message);
  }

  async sendReply(chatId: string, text: string, quoted: WAMessage): Promise<void> {
    if (!this.sock) throw new Error("Transport not started");
    const sent = await this.sock.sendMessage(chatId, { text }, { quoted });
    if (sent?.key?.id && sent.message) this.cacheMessage(sent.key.id, sent.message);
  }

  // Bounded message-content cache used to answer decryption retry receipts.
  private cacheMessage(id: string, content: WAMessageContent): void {
    this.messageCache.set(id, content);
    if (this.messageCache.size > 2000) {
      const oldest = this.messageCache.keys().next().value;
      if (oldest) this.messageCache.delete(oldest);
    }
  }

  async downloadAudio(raw: WAMessage): Promise<Buffer> {
    if (!this.sock) throw new Error("Transport not started");
    const buffer = (await downloadMediaMessage(
      raw,
      "buffer",
      {},
      { logger: this.opts.logger, reuploadRequest: this.sock.updateMediaMessage },
    )) as Buffer;
    return buffer;
  }

  async requestPairingCode(phoneNumber: string): Promise<string> {
    if (!this.sock) throw new Error("Transport not started");
    const code = await this.sock.requestPairingCode(phoneNumber.replace(/[^0-9]/g, ""));
    this.setStatus({ state: "pairing", pairingCode: code });
    return code;
  }

  // Re-pull the WhatsApp app-state (address book + chats) on the live session,
  // without re-linking. Emits contacts/chats events we ingest into the picker.
  async resyncContacts(): Promise<void> {
    if (!this.sock) throw new Error("Transport not started");
    await this.sock.resyncAppState(
      ["critical_unblock_low", "regular_high", "regular_low", "regular"],
      false,
    );
  }
}
