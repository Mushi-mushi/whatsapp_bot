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
import { ContactResolver } from "./contacts.js";
import type {
  ChatIdentity,
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
  private chatsCbs: ((chats: ChatIdentity[]) => void)[] = [];
  private groupSubjects = new Map<string, string>();
  private contacts = new ContactResolver();
  private pairingRequested = false;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private stopped = false;
  private starting = false;
  private consecutiveLogouts = 0;
  // Recently sent/seen message content, so we can answer decryption retry receipts
  // (otherwise the peer is stuck on "Waiting for this message").
  private messageCache = new Map<string, WAMessageContent>();

  constructor(private readonly opts: BaileysOptions) {}

  onMessage(cb: (m: IncomingMessage) => void): () => void {
    this.messageCbs.push(cb);
    return () => { this.messageCbs = this.messageCbs.filter((listener) => listener !== cb); };
  }

  onStatus(cb: (s: ConnectionStatus) => void): () => void {
    this.statusCbs.push(cb);
    return () => { this.statusCbs = this.statusCbs.filter((listener) => listener !== cb); };
  }

  onChatsDiscovered(cb: (chats: ChatIdentity[]) => void): () => void {
    this.chatsCbs.push(cb);
    return () => { this.chatsCbs = this.chatsCbs.filter((listener) => listener !== cb); };
  }

  private emitChats(chats: ChatIdentity[]): void {
    if (chats.length) for (const cb of this.chatsCbs) cb(chats);
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
    if (this.stopped || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      void this.start().catch((err) => {
        this.opts.logger.error({ err }, "reconnect failed");
        this.scheduleReconnect(Math.min(delayMs * 2, 30_000));
      });
    }, delayMs);
  }

  async start(): Promise<void> {
    if (this.stopped || this.starting) return;
    this.starting = true;
    try {
    // Hydrate the persisted contact directory once so DM names resolve after restarts.
    this.contacts.hydrate(this.opts.loadContacts);

    const { state, saveCreds } = await useMultiFileAuthState(this.opts.authDir);
    const { version } = await fetchLatestBaileysVersion();
    if (this.stopped) return;

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
      if (this.stopped || this.sock !== sock) return;
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
      if (this.stopped || this.sock !== sock) return;
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
          this.emitChats([{ id: g.id, name: g.subject }]);
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
    } finally {
      this.starting = false;
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    const socket = this.sock;
    this.sock = null;
    this.messageCbs = [];
    this.chatsCbs = [];
    this.statusCbs = [];
    socket?.end(new Error("Bot shutting down"));
  }

  private ingestContacts(contacts: Partial<Contact>[]): void {
    if (this.stopped) return;
    const { records } = this.contacts.ingest(contacts);
    if (records.length) this.opts.persistContacts?.(records);
    this.emitChats(records.map((record) => ({ id: record.jid, name: record.name })));
  }

  private ingestChats(chats: Chat[]): void {
    if (this.stopped) return;
    const names: ChatIdentity[] = [];
    for (const chat of chats) {
      if (!chat.id) continue;
      if (chat.id.endsWith("@g.us")) {
        const subject = chat.name?.trim() || this.groupSubjects.get(chat.id);
        if (subject) {
          this.groupSubjects.set(chat.id, subject);
          names.push({ id: chat.id, name: subject });
        }
      } else {
        const name = this.contacts.nameForJid(chat.id) || chat.name?.trim();
        if (name) names.push({ id: chat.id, name });
      }
    }
    this.emitChats(names);
  }

  private async prefetchGroups(): Promise<void> {
    try {
      const groups = await this.sock!.groupFetchAllParticipating();
      const names: ChatIdentity[] = [];
      for (const g of Object.values(groups)) {
        if (g.id && g.subject) {
          this.groupSubjects.set(g.id, g.subject);
          names.push({ id: g.id, name: g.subject });
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
      this.emitChats([{ id: jid, name: meta.subject }]);
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
      : this.contacts.resolveDmName({
          chatId,
          phoneJid,
          senderPhone,
          pushName: raw.pushName,
          senderId,
        });

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

  async sendImage(chatId: string, image: Buffer, caption?: string): Promise<void> {
    if (!this.sock) throw new Error("Transport not started");
    const sent = await this.sock.sendMessage(chatId, { image, caption });
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
    return this.downloadMedia(raw);
  }

  async downloadImage(raw: WAMessage): Promise<Buffer> {
    return this.downloadMedia(raw);
  }

  // Shared media download used by audio/image (and quoted-image) handlers.
  private async downloadMedia(raw: WAMessage): Promise<Buffer> {
    if (!this.sock) throw new Error("Transport not started");
    return (await downloadMediaMessage(
      raw,
      "buffer",
      {},
      { logger: this.opts.logger, reuploadRequest: this.sock.updateMediaMessage },
    )) as Buffer;
  }

  // Download an image the message is replying to (quoted). Returns null when the
  // reply doesn't quote an image.
  async downloadQuotedImage(raw: WAMessage): Promise<Buffer | null> {
    if (!this.sock) throw new Error("Transport not started");
    const ctxInfo = raw.message?.extendedTextMessage?.contextInfo;
    const quoted = ctxInfo?.quotedMessage;
    if (!quoted?.imageMessage) return null;
    const synthetic = {
      key: {
        remoteJid: raw.key.remoteJid,
        id: ctxInfo?.stanzaId,
        fromMe: false,
        participant: ctxInfo?.participant,
      },
      message: quoted,
    } as WAMessage;
    return this.downloadMedia(synthetic);
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
