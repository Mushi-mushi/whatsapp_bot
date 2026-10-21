import type {
  BotConfig, ConfigSnapshot, ConfigSaveResponse, Status, SiestaStatus,
  PetUpdate, PetRequestChoice, PetActionResponse, PetsResponse,
  ProfileDetail, ProfileRefreshResponse, ProfilesResponse,
  ChatsResponse, ContactsResponse, DisciplineResponse, DisciplineMutationResponse,
  PetRequest, PetEvolutionRequest, DisciplineTarget, DisciplineSleepRequest,
  OperationsResponse, ServiceDiagnosticsResponse, JobCancelResponse, UsageResetRequest, UsageResetResponse,
  RemindersResponse, ReminderCancelResponse, ReminderCreateRequest, ReminderUpdateRequest, ReminderMutationResponse,
  TellsResponse, TellCancelResponse, SuggestionsResponse, SuggestionDeleteResponse,
  FailedDeliveriesResponse, DeliveryHistoryResponse, DeliveryRetryRequest, DeliveryRetryResponse,
  AuditResponse, LeaderboardsResponse,
  BillingResponse, BillingChargeRequest, BillingChargeResponse,
} from "../../../shared/api.js";
export type {
  BotConfig, ConfigSnapshot, Status, ConnectionState, ConnectionHealth,
  ChatIdentity, SiestaStatus, DisciplinePlayer, Contact, ProfileSummary,
  ProfileDetail, PetSettings, GroupPet, PetGroup, PetsResponse, PetUpdate, PetRequestChoice,
  OperationsResponse, ServiceDiagnosticsResponse,
  ScheduledReminder, RemindersResponse, ReminderCreateRequest, ReminderUpdateRequest, ReminderMutationResponse, ReminderRecurrence,
  PendingTell, TellsResponse, SuggestionKind, SuggestionEntry, SuggestionsResponse, SuggestionDeleteResponse,
  FailedDelivery, FailedDeliveriesResponse, DeliveryHistoryResponse, DeliveryRetryRequest,
  AuditEntry, AuditResponse,
  BillingCustomer, BillingResponse,
  LeaderboardEntry, TrophyEntry, TrophyHistoryEntry, ChatParticipantEntry, ChatLeaderboards, LeaderboardsResponse,
} from "../../../shared/api.js";

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

export const api = {
  getBilling: () => fetch("/api/billing", { headers: authHeaders(), cache: "no-store" }).then(json<BillingResponse>),
  addBillingCharge: (request: BillingChargeRequest) =>
    fetch("/api/billing/charges", {
      method: "POST", headers: authHeaders({ "Content-Type": "application/json" }), body: JSON.stringify(request),
    }).then(json<BillingChargeResponse>),
  resetUsage: (request: UsageResetRequest) =>
    fetch("/api/usage/reset", {
      method: "POST", headers: authHeaders({ "Content-Type": "application/json" }), body: JSON.stringify(request),
    }).then(json<UsageResetResponse>),
  getAudit: (page = 1) =>
    fetch(`/api/operations/audit?page=${page}`, { headers: authHeaders(), cache: "no-store" }).then(json<AuditResponse>),
  getTells: (page = 1) =>
    fetch(`/api/tells?page=${page}`, { headers: authHeaders(), cache: "no-store" }).then(json<TellsResponse>),
  cancelTell: (id: number) =>
    fetch(`/api/tells/${id}`, { method: "DELETE", headers: authHeaders() }).then(json<TellCancelResponse>),
  getSuggestions: (page = 1) =>
    fetch(`/api/suggestions?page=${page}`, { headers: authHeaders(), cache: "no-store" }).then(json<SuggestionsResponse>),
  deleteSuggestion: (id: number) =>
    fetch(`/api/suggestions/${id}`, { method: "DELETE", headers: authHeaders() }).then(json<SuggestionDeleteResponse>),
  getFailedDeliveries: (page = 1) =>
    fetch(`/api/operations/failed-deliveries?page=${page}`, { headers: authHeaders(), cache: "no-store" }).then(json<FailedDeliveriesResponse>),
  getDeliveryHistory: (id: number) =>
    fetch(`/api/operations/deliveries/${id}/history`, { headers: authHeaders(), cache: "no-store" }).then(json<DeliveryHistoryResponse>),
  retryDelivery: (id: number, request: DeliveryRetryRequest) =>
    fetch(`/api/operations/deliveries/${id}/retry`, {
      method: "POST", headers: authHeaders({ "Content-Type": "application/json" }), body: JSON.stringify(request),
    }).then(json<DeliveryRetryResponse>),
  getReminders: (page = 1) =>
    fetch(`/api/reminders?page=${page}`, { headers: authHeaders(), cache: "no-store" }).then(json<RemindersResponse>),
  createReminder: (request: ReminderCreateRequest) =>
    fetch("/api/reminders", {
      method: "POST", headers: authHeaders({ "Content-Type": "application/json" }), body: JSON.stringify(request),
    }).then(json<ReminderMutationResponse>),
  updateReminder: (id: number, request: ReminderUpdateRequest) =>
    fetch(`/api/reminders/${id}`, {
      method: "PUT", headers: authHeaders({ "Content-Type": "application/json" }), body: JSON.stringify(request),
    }).then(json<ReminderMutationResponse>),
  cancelReminder: (id: number) =>
    fetch(`/api/reminders/${id}`, { method: "DELETE", headers: authHeaders() }).then(json<ReminderCancelResponse>),
  getLeaderboards: () =>
    fetch("/api/leaderboards", { headers: authHeaders(), cache: "no-store" }).then(json<LeaderboardsResponse>),
  getServiceDiagnostics: () =>
    fetch("/api/operations/services", { headers: authHeaders(), cache: "no-store" }).then(json<ServiceDiagnosticsResponse>),
  getOperations: () =>
    fetch("/api/operations", { headers: authHeaders(), cache: "no-store" }).then(json<OperationsResponse>),
  cancelJob: (id: string) =>
    fetch(`/api/operations/jobs/${encodeURIComponent(id)}`, { method: "DELETE", headers: authHeaders() }).then(json<JobCancelResponse>),
  getSiesta: () =>
    fetch("/api/siesta", { headers: authHeaders(), cache: "no-store" }).then(json<SiestaStatus>),
  cancelSiesta: () =>
    fetch("/api/siesta/cancel", { method: "POST", headers: authHeaders() }).then(
      json<{ ok: boolean; cancelled: boolean }>,
    ),
  evolvePet: (id: string, expectedStage: number) =>
    fetch(`/api/pets/${encodeURIComponent(id)}/evolve`, {
      method: "POST", headers: authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ expectedStage } satisfies PetEvolutionRequest),
    }).then(json<PetActionResponse>),
  requestPet: (id: string, kind: PetRequestChoice = "random") =>
    fetch(`/api/pets/${encodeURIComponent(id)}/request`, {
      method: "POST", headers: authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ kind } satisfies PetRequest),
    })
      .then(json<PetActionResponse>),
  getPets: () => fetch("/api/pets", { headers: authHeaders(), cache: "no-store" }).then(json<PetsResponse>),
  updatePet: (id: string, revision: string, update: PetUpdate) =>
    fetch(`/api/pets/${encodeURIComponent(id)}`, {
      method: "PUT",
      headers: authHeaders({ "Content-Type": "application/json", "If-Match": revision }),
      body: JSON.stringify(update),
    }).then(json<PetActionResponse>),
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
    const result = await json<ConfigSaveResponse>(response);
    return { config: result.config, revision: response.headers.get("etag") ?? "" };
  },
  getStatus: (signal?: AbortSignal) => fetch("/api/status", {
    headers: authHeaders(),
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(8000)]) : AbortSignal.timeout(8000),
  }).then(json<Status>),
  getChats: () => fetch("/api/chats", { headers: authHeaders() }).then(json<ChatsResponse>),
  getOllamaModels: () =>
    fetch("/api/ollama/models", { headers: authHeaders() }).then(
      json<{ ok: boolean; models: string[] }>,
    ),
  getComfyStatus: () =>
    fetch("/api/comfyui/status", { headers: authHeaders() }).then(
      json<{ reachable: boolean; version?: string | null }>,
    ),
  resetTriviaScores: () =>
    fetch("/api/trivia/reset", { method: "POST", headers: authHeaders() }).then(
      json<{ ok: boolean }>,
    ),
  getProfiles: () =>
    fetch("/api/profiles", { headers: authHeaders() }).then(
      json<ProfilesResponse>,
    ),
  getProfile: (key: string) =>
    fetch(`/api/profiles/${encodeURIComponent(key)}`, { headers: authHeaders() }).then(
      json<ProfileDetail>,
    ),
  refreshProfile: (key: string) =>
    fetch(`/api/profiles/${encodeURIComponent(key)}/refresh`, { method: "POST", headers: authHeaders() }).then(
      json<ProfileRefreshResponse>,
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
      json<DisciplineResponse>,
    ),
  getContacts: () =>
    fetch("/api/contacts", { headers: authHeaders(), cache: "no-store" }).then(
      json<ContactsResponse>,
    ),
  sleepPlayer: (chatId: string, senderId: string, minutes: number) =>
    fetch("/api/discipline/sleep", {
      method: "POST",
      headers: authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ chatId, senderId, minutes } satisfies DisciplineSleepRequest),
    }).then(json<DisciplineMutationResponse>),
  armPlayer: (chatId: string, senderId: string) =>
    fetch("/api/discipline/arm", {
      method: "POST",
      headers: authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ chatId, senderId } satisfies DisciplineTarget),
    }).then(json<DisciplineMutationResponse>),
  wakePlayer: (chatId: string, senderId: string) =>
    fetch("/api/discipline/wake", {
      method: "POST",
      headers: authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ chatId, senderId } satisfies DisciplineTarget),
    }).then(json<DisciplineMutationResponse>),
};
