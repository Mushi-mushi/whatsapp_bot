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
  redditClientId: string;
  redditClientSecret: string;
  redditUserAgent: string;
  redditRefreshToken: string;
  paintEnabled: boolean;
  paintBaseUrl: string;
  paintCheckpoint: string;
  paintFluxCheckpoint: string;
  paintSampler: string;
  paintScheduler: string;
  paintSteps: number;
  paintWidth: number;
  paintHeight: number;
  paintCfgScale: number;
  paintNegativePrompt: string;
  paintDenoise: number;
  paintGuidance: number;
  botReplyPrefix: string;
  acknowledgeMedia: boolean;
  respondToOwnCommands: boolean;
  approvedSenders: string[];
  commands: Record<string, string>;
  keywordResponses: Record<string, string>;
}

export type ConnectionState = "connecting" | "qr" | "pairing" | "open" | "close";

export interface ChatIdentity {
  id: string;
  name: string;
}

export interface Status {
  state: ConnectionState;
  qrDataUrl: string | null;
  pairingCode: string | null;
  me: string | null;
}

const TOKEN_KEY = "apiToken";
let authToken = localStorage.getItem(TOKEN_KEY) ?? "";

export function getToken(): string {
  return authToken;
}

export function setToken(token: string): void {
  authToken = token.trim();
  if (authToken) localStorage.setItem(TOKEN_KEY, authToken);
  else localStorage.removeItem(TOKEN_KEY);
}

export function clearToken(): void {
  setToken("");
}

export class ApiError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
    this.name = "ApiError";
  }
}

function authHeaders(extra?: HeadersInit): HeadersInit {
  const headers = new Headers(extra);
  if (authToken) headers.set("Authorization", `Bearer ${authToken}`);
  return headers;
}

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const detail = await res.json().catch(() => null) as { error?: unknown } | null;
    const message = typeof detail?.error === "string" ? detail.error : detail?.error ? JSON.stringify(detail.error) : `${res.status} ${res.statusText}`;
    throw new ApiError(res.status, message);
  }
  return res.json() as Promise<T>;
}

export interface ConfigSnapshot {
  config: BotConfig;
  revision: string;
}

export const api = {
  getConfig: async (): Promise<ConfigSnapshot> => {
    const response = await fetch("/api/config", { headers: authHeaders(), cache: "no-store" });
    return { config: await json<BotConfig>(response), revision: response.headers.get("etag") ?? "" };
  },
  saveConfig: async ({ config, revision }: ConfigSnapshot): Promise<ConfigSnapshot> => {
    const response = await fetch("/api/config", {
      method: "PUT",
      headers: authHeaders({ "Content-Type": "application/json", "If-Match": revision }),
      body: JSON.stringify(config),
    });
    const result = await json<{ ok: boolean; config: BotConfig }>(response);
    return { config: result.config, revision: response.headers.get("etag") ?? "" };
  },
  getStatus: () => fetch("/api/status", { headers: authHeaders() }).then(json<Status>),
  getChats: () => fetch("/api/chats", { headers: authHeaders() }).then(json<{ chats: ChatIdentity[] }>),
  getOllamaModels: () =>
    fetch("/api/ollama/models", { headers: authHeaders() }).then(
      json<{ ok: boolean; models: string[] }>,
    ),
  resetTriviaScores: () =>
    fetch("/api/trivia/reset", { method: "POST", headers: authHeaders() }).then(
      json<{ ok: boolean }>,
    ),
  requestPairing: (phoneNumber: string) =>
    fetch("/api/pair", {
      method: "POST",
      headers: authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ phoneNumber }),
    }).then(json<{ ok: boolean; code?: string; error?: string }>),
};
