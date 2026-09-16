export interface BotConfig {
  transcriptionEnabled: boolean;
  transcriptionProvider: string;
  auralisBaseUrl: string;
  transcriptionTimeoutSeconds: number;
  audioDownloadEnabled: boolean;
  askEnabled: boolean;
  ollamaBaseUrl: string;
  ollamaModel: string;
  ollamaTimeoutSeconds: number;
  askSystemPrompt: string;
  botReplyPrefix: string;
  acknowledgeMedia: boolean;
  respondToOwnCommands: boolean;
  approvedSenders: string[];
  commands: Record<string, string>;
  keywordResponses: Record<string, string>;
}

export type ConnectionState = "connecting" | "qr" | "pairing" | "open" | "close";

export interface Status {
  state: ConnectionState;
  qrDataUrl: string | null;
  pairingCode: string | null;
  me: string | null;
}

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.json() as Promise<T>;
}

export const api = {
  getConfig: () => fetch("/api/config").then(json<BotConfig>),
  saveConfig: (config: BotConfig) =>
    fetch("/api/config", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(config),
    }).then(json<{ ok: boolean; config: BotConfig }>),
  getStatus: () => fetch("/api/status").then(json<Status>),
  getChats: () => fetch("/api/chats").then(json<{ chats: string[] }>),
  getOllamaModels: () =>
    fetch("/api/ollama/models").then(json<{ ok: boolean; models: string[] }>),
  requestPairing: (phoneNumber: string) =>
    fetch("/api/pair", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ phoneNumber }),
    }).then(json<{ ok: boolean; code?: string; error?: string }>),
};
