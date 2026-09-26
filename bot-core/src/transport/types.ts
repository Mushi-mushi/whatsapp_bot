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

export interface ChatIdentity {
  id: string;
  name: string;
}

export interface ConnectionStatus {
  state: ConnectionState;
  qrDataUrl: string | null;
  pairingCode: string | null;
  me: string | null;
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
  getStatus(): ConnectionStatus;
  onMessage(cb: (m: IncomingMessage) => void): () => void;
  onStatus(cb: (s: ConnectionStatus) => void): () => void;
  onChatsDiscovered(cb: (chats: ChatIdentity[]) => void): () => void;
}
