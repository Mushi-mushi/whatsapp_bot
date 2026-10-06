import type { WAMessage } from "@whiskeysockets/baileys";

export type MessageKind = "text" | "audio" | "image" | "video" | "sticker" | "other";

export interface IncomingMessage {
  chatId: string;
  chatName: string;
  senderId: string;
  senderName: string;
  senderPhone: string;
  messageId: string;
  fromMe: boolean;
  isGroup: boolean;
  text: string | null;
  kind: MessageKind;
  timestamp: number;
  raw: WAMessage;
}

export type ConnectionState = "connecting" | "qr" | "pairing" | "open" | "close";

// Liveness of an "open" socket. WhatsApp can silently drop a linked device: the
// socket stays "open" but queries hang and no messages arrive. "stale" marks that.
export type ConnectionHealth = "online" | "stale" | "unknown";

export interface ChatIdentity {
  id: string;
  name: string;
}

export interface ConnectionStatus {
  state: ConnectionState;
  health: ConnectionHealth;
  qrDataUrl: string | null;
  pairingCode: string | null;
  me: string | null;
  lastActivityAt: number | null;
}

export interface Transport {
  start(): Promise<void>;
  stop(): Promise<void>;
  sendText(chatId: string, text: string): Promise<void>;
  sendReply(chatId: string, text: string, quoted: WAMessage): Promise<void>;
  sendImage(chatId: string, image: Buffer, caption?: string): Promise<void>;
  sendVideo(chatId: string, video: Buffer, caption?: string): Promise<void>;
  downloadAudio(raw: WAMessage): Promise<Buffer>;
  downloadImage(raw: WAMessage): Promise<Buffer>;
  downloadQuotedImage(raw: WAMessage): Promise<Buffer | null>;
  requestPairingCode(phoneNumber: string): Promise<string>;
  resyncContacts(): Promise<void>;
  relink(): Promise<void>;
  getStatus(): ConnectionStatus;
  onMessage(cb: (m: IncomingMessage) => void): () => void;
  onStatus(cb: (s: ConnectionStatus) => void): () => void;
  onChatsDiscovered(cb: (chats: ChatIdentity[]) => void): () => void;
}
