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
  ollamaKeepAlive: string;
  askSystemPrompt: string;
  userMemoryEnabled: boolean;
  userMemoryLimit: number;
  userMemoryContext: number;
  profileRefreshEvery: number;
  profileMaxAgeDays: number;
  profileSampleSize: number;
  profileShortMaxChars: number;
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
  deleteInstagramPosts: boolean;
  instagramDeleteSenders: string[];
  respondToOwnCommands: boolean;
  approvedSenders: string[];
  commands: Record<string, string>;
  keywordResponses: Record<string, string>;
}

export type ConnectionState = "connecting" | "qr" | "pairing" | "open" | "close";
export type ConnectionHealth = "online" | "stale" | "unknown";

export interface ChatIdentity {
  id: string;
  name: string;
}

export interface Status {
  state: ConnectionState;
  health: ConnectionHealth;
  qrDataUrl: string | null;
  pairingCode: string | null;
  me: string | null;
  lastActivityAt: number | null;
}

export interface SiestaStatus {
  sleeping: boolean;
  until: number | null;
}

export interface DisciplinePlayer {
  chatId: string;
  chatName: string | null;
  senderId: string;
  displayName: string | null;
  sleepUntil: number | null;
  armed: boolean;
}

export interface Contact {
  jid: string;
  name: string;
  phone: string | null;
}

const TOKEN_KEY = "apiToken";
let authToken = localStorage.getItem(TOKEN_KEY) ?? "";
const tokenListeners = new Set<() => void>();

export function subscribeToken(listener: () => void): () => void {
  tokenListeners.add(listener);
  return () => { tokenListeners.delete(listener); };
}

export function getToken(): string {
  return authToken;
}

export function setToken(token: string): void {
  const next = token.trim();
  if (next) localStorage.setItem(TOKEN_KEY, next);
  else localStorage.removeItem(TOKEN_KEY);
  if (next === authToken) return;
  authToken = next;
  for (const listener of tokenListeners) listener();
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

export interface ProfileSummary {
  sender_key: string;
  name: string;
  short: string;
  updated_at: number;
  messageCount: number;
}

export interface ProfileDetail extends ProfileSummary {
  deep: string;
}

export interface PetSettings {
  wakeStart: number;
  wakeEnd: number;
  firstRequestMinutes: number;
  requestMinHours: number;
  requestMaxHours: number;
  maxRequestsPerDay: number;
  activityWindowHours: number;
  responseMinutes: number;
  silenceMinutes: number;
}
export interface GroupPet {
  name: string;
  species: string;
  enabled: boolean;
  paused: boolean;
  settings: PetSettings;
  stage: number;
  hunger: number;
  hydration: number;
  cleanliness: number;
  happiness: number;
  energy: number;
  hibernating: boolean;
  healthyDays: number;
  evolution: {
    nextForm: string | null;
    remainingHealthyMs: number;
    sampledAt: number;
    running: boolean;
    frozenReason: string | null;
    canForce: boolean;
  };
  status: string;
  nextRequestActiveMinutes: number;
  request: { kind: string; delivered: boolean } | null;
}
export interface PetGroup {
  id: string;
  name: string;
  pet: GroupPet | null;
  revision: string;
}
export interface PetsResponse {
  groups: PetGroup[];
  species: Record<string, { name: string; forms: string[]; emoji: string[] }>;
  defaults: PetSettings;
}
export interface PetUpdate {
  action: "save" | "enable" | "disable" | "pause" | "resume";
  name: string;
  species: string;
  settings: PetSettings;
}

export type PetRequestChoice = "random" | "feed" | "water" | "clean" | "play" | "silence";

export const api = {
  getSiesta: () =>
    fetch("/api/siesta", { headers: authHeaders(), cache: "no-store" }).then(json<SiestaStatus>),
  cancelSiesta: () =>
    fetch("/api/siesta/cancel", { method: "POST", headers: authHeaders() }).then(
      json<{ ok: boolean; cancelled: boolean }>,
    ),
  evolvePet: (id: string, expectedStage: number) =>
    fetch(`/api/pets/${encodeURIComponent(id)}/evolve`, {
      method: "POST", headers: authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ expectedStage }),
    }).then(json<{ pet: GroupPet; revision: string }>),
  requestPet: (id: string, kind: PetRequestChoice = "random") =>
    fetch(`/api/pets/${encodeURIComponent(id)}/request`, {
      method: "POST", headers: authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ kind }),
    })
      .then(json<{ pet: GroupPet; revision: string }>),
  getPets: () => fetch("/api/pets", { headers: authHeaders(), cache: "no-store" }).then(json<PetsResponse>),
  updatePet: (id: string, revision: string, update: PetUpdate) =>
    fetch(`/api/pets/${encodeURIComponent(id)}`, {
      method: "PUT",
      headers: authHeaders({ "Content-Type": "application/json", "If-Match": revision }),
      body: JSON.stringify(update),
    }).then(json<{ pet: GroupPet; revision: string }>),
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
  getStatus: (signal?: AbortSignal) => fetch("/api/status", {
    headers: authHeaders(),
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(8000)]) : AbortSignal.timeout(8000),
  }).then(json<Status>),
  getChats: () => fetch("/api/chats", { headers: authHeaders() }).then(json<{ chats: ChatIdentity[] }>),
  getOllamaModels: () =>
    fetch("/api/ollama/models", { headers: authHeaders() }).then(
      json<{ ok: boolean; models: string[] }>,
    ),
  getComfyStatus: async (): Promise<{ reachable: boolean; version?: string | null }> => {
    try {
      const res = await fetch("/api/comfyui/status", { headers: authHeaders() });
      if (res.status === 401) throw new ApiError(401, "unauthorized");
      const data = (await res.json().catch(() => ({}))) as { reachable?: boolean; version?: string | null };
      return { reachable: !!data.reachable, version: data.version };
    } catch (err) {
      if (err instanceof ApiError) throw err;
      return { reachable: false };
    }
  },
  resetTriviaScores: () =>
    fetch("/api/trivia/reset", { method: "POST", headers: authHeaders() }).then(
      json<{ ok: boolean }>,
    ),
  getProfiles: () =>
    fetch("/api/profiles", { headers: authHeaders() }).then(
      json<{ profiles: ProfileSummary[] }>,
    ),
  getProfile: (key: string) =>
    fetch(`/api/profiles/${encodeURIComponent(key)}`, { headers: authHeaders() }).then(
      json<ProfileDetail>,
    ),
  refreshProfile: (key: string) =>
    fetch(`/api/profiles/${encodeURIComponent(key)}/refresh`, { method: "POST", headers: authHeaders() }).then(
      json<{ ok: boolean; profile?: ProfileDetail; error?: string }>,
    ),
  deleteProfile: (key: string) =>
    fetch(`/api/profiles/${encodeURIComponent(key)}`, { method: "DELETE", headers: authHeaders() }).then(
      json<{ ok: boolean }>,
    ),
  requestPairing: (phoneNumber: string) =>
    fetch("/api/pair", {
      method: "POST",
      headers: authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ phoneNumber }),
    }).then(json<{ ok: boolean; code?: string; error?: string }>),
  relink: () =>
    fetch("/api/relink", { method: "POST", headers: authHeaders() }).then(
      json<{ ok: boolean; error?: string }>,
    ),
  getDiscipline: () =>
    fetch("/api/discipline", { headers: authHeaders(), cache: "no-store" }).then(
      json<{ players: DisciplinePlayer[] }>,
    ),
  getContacts: () =>
    fetch("/api/contacts", { headers: authHeaders(), cache: "no-store" }).then(
      json<{ contacts: Contact[] }>,
    ),
  sleepPlayer: (chatId: string, senderId: string, minutes: number) =>
    fetch("/api/discipline/sleep", {
      method: "POST",
      headers: authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ chatId, senderId, minutes }),
    }).then(json<{ ok: boolean; players: DisciplinePlayer[] }>),
  armPlayer: (chatId: string, senderId: string) =>
    fetch("/api/discipline/arm", {
      method: "POST",
      headers: authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ chatId, senderId }),
    }).then(json<{ ok: boolean; players: DisciplinePlayer[] }>),
  wakePlayer: (chatId: string, senderId: string) =>
    fetch("/api/discipline/wake", {
      method: "POST",
      headers: authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ chatId, senderId }),
    }).then(json<{ ok: boolean; players: DisciplinePlayer[] }>),
};
