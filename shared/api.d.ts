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
// An open socket can still be stale when probes or inbound events stop progressing.
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

// The revision comes from HTTP ETag, not from the configuration JSON body.
export interface ConfigSnapshot {
  config: BotConfig;
  revision: string;
}

export interface ProfileSummary {
  // Opaque identity of one person within one chat; URL-encode for API paths.
  sender_key: string;
  chat_id: string;
  chat_name: string | null;
  name: string;
  short: string;
  updated_at: number;
  messageCount: number;
}

export interface ProfileDetail extends ProfileSummary {
  deep: string;
  last_profiled_id: number;
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
  species: Record<string, { name: string; forms: readonly string[]; emoji: readonly string[] }>;
  defaults: PetSettings;
}

export interface PetUpdate {
  action: "save" | "enable" | "disable" | "pause" | "resume";
  name: string;
  species: string;
  settings: PetSettings;
}

export type PetRequestChoice = "random" | "feed" | "water" | "clean" | "play" | "silence";

export interface PetRequest {
  kind: PetRequestChoice;
}

export interface PetEvolutionRequest {
  expectedStage: number;
}

export interface DisciplineTarget {
  chatId: string;
  senderId: string;
}

export interface DisciplineSleepRequest extends DisciplineTarget {
  minutes: number;
}

export interface PetActionResponse {
  pet: GroupPet;
  revision: string;
}

export interface ConfigSaveResponse {
  ok: true;
  config: BotConfig;
}

export interface ProfilesResponse {
  profiles: ProfileSummary[];
}

export interface ProfileRefreshResponse {
  ok: true;
  profile: ProfileDetail;
}

export interface ChatsResponse {
  chats: ChatIdentity[];
}

export interface ContactsResponse {
  contacts: Contact[];
}

export interface DisciplineResponse {
  players: DisciplinePlayer[];
}

export interface DisciplineMutationResponse extends DisciplineResponse {
  ok: true;
}
