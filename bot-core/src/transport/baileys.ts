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
import { phoneFromJid } from "../state/identity.js";
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
    health: "unknown",
    qrDataUrl: null,
    pairingCode: null,
    me: null,
    lastActivityAt: null,
  };
  private messageCbs: ((m: IncomingMessage) => void)[] = [];
  private statusCbs: ((s: ConnectionStatus) => void)[] = [];
  private chatsCbs: ((chats: ChatIdentity[]) => void)[] = [];
  private groupSubjects = new Map<string, string>();
  private contacts = new ContactResolver();
  private pairingRequested = false;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private reconnectDelayMs = 2000;
  private stopped = false;
  private starting = false;
  private consecutiveLogouts = 0;
  private healthTimer?: ReturnType<typeof setInterval>;
  private healthFailures = 0;
  private bufferedSince: number | null = null;
  private lastActivityAt: number | null = null;
  // Recently sent/seen message content, so we can answer decryption retry receipts
  // (otherwise the peer is stuck on "Waiting for this message").
  private messageCache = new Map<string, WAMessageContent>();
  private sentMessageIds = new Set<string>();

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

  async isGroupAdmin(chatId: string, senderId: string): Promise<boolean> {
    if (!this.sock || this.status.state !== "open") throw new Error("WhatsApp is disconnected");
    const metadata = await this.sock.groupMetadata(chatId);
    this.ingestContacts(metadata.participants);
    const sender = this.contacts.canonical(senderId);
    return metadata.participants.some((participant) =>
      this.contacts.canonical(participant.id) === sender &&
      (participant.admin === "admin" || participant.admin === "superadmin"));
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

  // Any inbound socket traffic proves the link is alive; clears a prior stale flag.
  private noteInbound(): void {
    this.lastActivityAt = Date.now();
    this.healthFailures = 0;
    this.bufferedSince = null;
    this.reconnectDelayMs = 2000;
    if (this.status.state === "open" && this.status.health !== "online") {
      this.setStatus({ health: "online", lastActivityAt: this.lastActivityAt });
    } else {
      this.status.lastActivityAt = this.lastActivityAt;
    }
  }

  private startHealthMonitor(): void {
    this.stopHealthMonitor();
    this.healthTimer = setInterval(() => void this.probeHealth(), 60_000);
    this.healthTimer.unref?.();
  }

  private stopHealthMonitor(): void {
    if (this.healthTimer) {
      clearInterval(this.healthTimer);
      this.healthTimer = undefined;
    }
    this.bufferedSince = null;
  }

  // Queries can succeed while Baileys buffers incoming events indefinitely.
  // Check both paths; a quiet chat alone is not evidence of a dead connection.
  private async probeHealth(): Promise<void> {
    const sock = this.sock;
    if (this.stopped || this.status.state !== "open" || !sock) return;
    if (sock.ev.isBuffering()) {
      this.bufferedSince ??= Date.now();
      if (Date.now() - this.bufferedSince >= 60_000) {
        this.recoverConnection(sock, "Incoming WhatsApp events remained buffered across health checks");
        return;
      }
    } else {
      this.bufferedSince = null;
    }
    const me = sock.user?.id;
    const number = me ? me.split(":")[0].split("@")[0].replace(/\D/g, "") : "";
    if (!number) return;
    try {
      const res = await this.withTimeout(sock.onWhatsApp(number), 20_000);
      if (this.stopped || this.sock !== sock || this.status.state !== "open") return;
      if (res && res.length) {
        this.healthFailures = 0;
        this.setStatus({ health: "online", lastActivityAt: Date.now() });
      } else {
        this.registerHealthFailure(sock);
      }
    } catch (err) {
      if (this.stopped || this.sock !== sock || this.status.state !== "open") return;
      this.opts.logger.warn({ err }, "health probe failed");
      this.registerHealthFailure(sock);
    }
  }

  private registerHealthFailure(sock: WASocket): void {
    this.healthFailures += 1;
    if (this.healthFailures >= 2) {
      this.recoverConnection(sock, "Repeated WhatsApp health probe failures");
    }
  }

  private recoverConnection(sock: WASocket, reason: string): void {
    if (this.stopped || this.sock !== sock) return;
    this.opts.logger.warn({ reason }, "Reconnecting WhatsApp with the saved session");
    this.sock = null;
    this.stopHealthMonitor();
    this.setStatus({ state: "connecting", health: "stale" });
    try {
      sock.end(new Error(reason));
    } catch (err) {
      this.opts.logger.warn({ err }, "Failed to close unhealthy WhatsApp socket");
    }
    this.scheduleReconnect();
  }

  private withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("probe timed out")), ms);
      promise.then(
        (value) => { clearTimeout(timer); resolve(value); },
        (err) => { clearTimeout(timer); reject(err); },
      );
    });
  }

  // Schedule a single reconnect, coalescing overlapping close events so we never
  // spin up multiple concurrent sockets.
  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return;
    const delayMs = this.reconnectDelayMs;
    this.reconnectDelayMs = Math.min(delayMs * 2, 30_000);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      void this.start().catch((err) => {
        this.opts.logger.error({ err }, "reconnect failed");
        this.scheduleReconnect();
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
        this.stopHealthMonitor();
        this.setStatus({ state: "qr", health: "unknown", qrDataUrl: await QRCode.toDataURL(qr) });
      }
      if (connection === "open") {
        this.consecutiveLogouts = 0;
        this.healthFailures = 0;
        this.lastActivityAt = Date.now();
        this.setStatus({
          state: "open",
          health: "online",
          qrDataUrl: null,
          pairingCode: null,
          me: sock.user?.id ?? null,
          lastActivityAt: this.lastActivityAt,
        });
        this.startHealthMonitor();
        void this.prefetchGroups();
      } else if (connection === "close") {
        const statusCode = (lastDisconnect?.error as { output?: { statusCode?: number } } | undefined)
          ?.output?.statusCode;
        const loggedOut = statusCode === DisconnectReason.loggedOut;
        this.stopHealthMonitor();
        this.setStatus({ state: "close", health: "unknown" });
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
      this.noteInbound();
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
        try {
          const incoming = await this.toIncoming(raw);
          if (incoming) for (const cb of this.messageCbs) cb(incoming);
        } catch (err) {
          this.opts.logger.error({ err }, "Failed to resolve incoming WhatsApp message");
        }
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
      this.syncContacts(contacts);
      this.ingestChats(chats);
    });
    sock.ev.on("contacts.upsert", (contacts) => this.syncContacts(contacts));
    sock.ev.on("contacts.update", (contacts) => this.syncContacts(contacts));
    sock.ev.on("chats.upsert", (chats) => this.ingestChats(chats));
    } finally {
      this.starting = false;
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    this.stopHealthMonitor();
    const socket = this.sock;
    this.sock = null;
    this.messageCbs = [];
    this.chatsCbs = [];
    this.statusCbs = [];
    socket?.end(new Error("Bot shutting down"));
  }

  private ingestContacts(contacts: Partial<Contact>[]): void {
    if (this.stopped) return;
    const staged = this.contacts.clone();
    const { records } = staged.ingest(contacts);
    if (records.length) this.opts.persistContacts?.(records);
    this.contacts = staged;
    this.emitChats(records.filter((r) => r.name).map((record) => ({ id: record.jid, name: record.name })));
  }

  private syncContacts(contacts: Partial<Contact>[]): void {
    try {
      this.ingestContacts(contacts);
    } catch (err) {
      this.opts.logger.error({ err }, "Failed to update WhatsApp contact identities");
    }
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
    // Our own messages carry the chat partner's jid in the key, so attribute them
    // to the linked account instead — otherwise the owner's profile/activity would
    // be keyed to whoever they were talking to.
    const ownJid = fromMe ? this.sock?.user?.id : undefined;
    if (fromMe && !ownJid) throw new Error("Linked account identity is unavailable");
    const senderId = ownJid ?? (isGroup ? raw.key.participant ?? chatId : chatId);

    const key = raw.key;
    const phoneJid = (isGroup ? key.participantPn : key.senderPn) ?? undefined;
    const lid = (isGroup ? key.participantLid : key.senderLid) ?? undefined;
    if (phoneJid && !phoneFromJid(phoneJid)) throw new Error("Invalid WhatsApp phone alias");
    if (lid && !/^\d+(?::\d+)?@lid$/.test(lid)) throw new Error("Invalid WhatsApp LID alias");
    const phone = phoneFromJid(phoneJid ?? "") ?? this.contacts.phoneFor(senderId);
    // Sender hints describe the author, including on outgoing DMs; never bind
    // the recipient's remoteJid to the linked account's phone.
    if ((phoneJid && this.contacts.phoneFor(senderId) !== phone) ||
        (lid && phone && this.contacts.phoneFor(lid) !== phone)) {
      this.ingestContacts([{ id: senderId, jid: phoneJid, lid }]);
    }
    const senderPhone = this.contacts.phoneFor(senderId) ?? "";
    const senderIdentity = this.contacts.canonical(senderId);
    const chatIdentity = isGroup ? chatId : this.contacts.canonical(chatId);

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
          phoneJid: this.contacts.phoneFor(chatId) ? chatIdentity : undefined,
          senderPhone: this.contacts.phoneFor(chatId) ?? "",
          pushName: fromMe ? null : raw.pushName,
          senderId: chatId,
        });

    return {
      chatId,
      chatIdentity,
      chatAliases: isGroup ? [chatId] : this.contacts.aliasesFor(chatId),
      chatName,
      senderId,
      senderIdentity,
      senderName: (fromMe ? this.sock?.user?.name ?? this.sock?.user?.notify : null) ?? raw.pushName ?? senderId,
      senderPhone,
      messageId: raw.key.id ?? "",
      fromMe,
      isBot: fromMe && this.sentMessageIds.has(raw.key.id ?? ""),
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
    this.cacheOutgoing(sent);
  }

  async sendReply(chatId: string, text: string, quoted: WAMessage): Promise<void> {
    if (!this.sock) throw new Error("Transport not started");
    const sent = await this.sock.sendMessage(chatId, { text }, { quoted });
    this.cacheOutgoing(sent);
  }

  async sendImage(chatId: string, image: Buffer, caption?: string): Promise<void> {
    if (!this.sock) throw new Error("Transport not started");
    const sent = await this.sock.sendMessage(chatId, { image, caption });
    this.cacheOutgoing(sent);
  }

  async sendVideo(chatId: string, video: Buffer, caption?: string): Promise<void> {
    if (!this.sock) throw new Error("Transport not started");
    const sent = await this.sock.sendMessage(chatId, { video, caption, mimetype: "video/mp4" });
    this.cacheOutgoing(sent);
  }

  private cacheOutgoing(sent: WAMessage | undefined): void {
    if (!sent?.key?.id || !sent.message) return;
    this.cacheMessage(sent.key.id, sent.message);
    this.sentMessageIds.add(sent.key.id);
    if (this.sentMessageIds.size > 1000) {
      const oldest = this.sentMessageIds.values().next().value;
      if (oldest) this.sentMessageIds.delete(oldest);
    }
  }

  // Delete a message for everyone. In groups this requires the bot to be an admin;
  // in DMs only the bot's own messages can be removed for everyone.
  async deleteMessage(chatId: string, key: WAMessageKey): Promise<void> {
    if (!this.sock) throw new Error("Transport not started");
    await this.sock.sendMessage(chatId, { delete: key });
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

  // Operator-triggered recovery: tear down the current socket, wipe the stored
  // credentials, and reconnect so WhatsApp issues a fresh QR / pairing code.
  // Used when the link goes "stale" (device silently logged out).
  async relink(): Promise<void> {
    this.opts.logger.warn("Re-link requested — clearing session and reconnecting.");
    const socket = this.sock;
    this.sock = null;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    this.stopHealthMonitor();
    try {
      socket?.end(new Error("Re-linking"));
    } catch {
      // socket may already be closed
    }
    this.pairingRequested = false;
    this.consecutiveLogouts = 0;
    this.healthFailures = 0;
    this.lastActivityAt = null;
    await this.clearAuth();
    this.setStatus({
      state: "connecting",
      health: "unknown",
      qrDataUrl: null,
      pairingCode: null,
      me: null,
      lastActivityAt: null,
    });
    await this.start();
  }
}
