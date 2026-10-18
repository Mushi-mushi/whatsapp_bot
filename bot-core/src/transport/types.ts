import type { WAMessage, WAMessageKey } from "@whiskeysockets/baileys";
import type { ChatIdentity, Status as ConnectionStatus } from "../../../shared/api.js";
export type {
  ChatIdentity, ConnectionState, ConnectionHealth, Status as ConnectionStatus,
} from "../../../shared/api.js";

export type MessageKind = "text" | "audio" | "image" | "video" | "sticker" | "other";

export interface IncomingMessage {
  chatId: string;
  chatName: string;
  senderId: string;
  senderName: string;
  senderPhone: string;
  messageId: string;
  fromMe: boolean;
  isBot?: boolean;
  isGroup: boolean;
  text: string | null;
  kind: MessageKind;
  timestamp: number;
  raw: WAMessage;
}

export interface Transport {
  start(): Promise<void>;
  stop(): Promise<void>;
  sendText(chatId: string, text: string): Promise<void>;
  sendReply(chatId: string, text: string, quoted: WAMessage): Promise<void>;
  sendImage(chatId: string, image: Buffer, caption?: string): Promise<void>;
  sendVideo(chatId: string, video: Buffer, caption?: string): Promise<void>;
  deleteMessage(chatId: string, key: WAMessageKey): Promise<void>;
  downloadAudio(raw: WAMessage): Promise<Buffer>;
  downloadImage(raw: WAMessage): Promise<Buffer>;
  downloadQuotedImage(raw: WAMessage): Promise<Buffer | null>;
  requestPairingCode(phoneNumber: string): Promise<string>;
  resyncContacts(): Promise<void>;
  relink(): Promise<void>;
  getStatus(): ConnectionStatus;
  isGroupAdmin?(chatId: string, senderId: string): Promise<boolean>;
  onMessage(cb: (m: IncomingMessage) => void): () => void;
  onStatus(cb: (s: ConnectionStatus) => void): () => void;
  onChatsDiscovered(cb: (chats: ChatIdentity[]) => void): () => void;
}
