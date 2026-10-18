import type { BotConfig, OperationsResponse } from "@/lib/api";

export const config: BotConfig = {
  transcriptionEnabled: true, transcriptionProvider: "auralis", auralisBaseUrl: "http://auralis:8000",
  transcriptionTimeoutSeconds: 90, audioDownloadEnabled: true,
  askEnabled: true, ollamaBaseUrl: "http://ollama:11434", ollamaModel: "test-model",
  ollamaTimeoutSeconds: 120, ollamaKeepAlive: "5m", askSystemPrompt: "Be concise.",
  userMemoryEnabled: true, userMemoryLimit: 50, userMemoryContext: 20,
  profileRefreshEvery: 25, profileMaxAgeDays: 7, profileSampleSize: 50, profileShortMaxChars: 400,
  redditClientId: "", redditClientSecret: "", redditUserAgent: "test", redditRefreshToken: "",
  paintEnabled: false, paintBaseUrl: "http://comfyui:8188", paintCheckpoint: "test.safetensors",
  paintFluxCheckpoint: "flux.safetensors", paintSampler: "euler", paintScheduler: "normal",
  paintSteps: 24, paintWidth: 768, paintHeight: 768, paintCfgScale: 7,
  paintNegativePrompt: "", paintDenoise: 0.5, paintGuidance: 3.5,
  botReplyPrefix: "original", acknowledgeMedia: false, deleteInstagramPosts: false,
  instagramDeleteSenders: [], respondToOwnCommands: true, approvedSenders: [],
  commands: { "bot.ask": "ask" }, keywordResponses: {},
};

export const operations: OperationsResponse = {
  sampledAt: 1700000100000, startedAt: 1700000000000, deliveryReady: true,
  jobs: {
    capacity: 8, accepting: true, running: null, queued: 0, oldestQueuedAt: null,
    completed: 0, failed: 0, rejected: { capacity: 0, duplicate: 0, stopping: 0 }, recentFailures: [],
  },
  outbox: {
    counts: { pending: 0, sending: 0, failed: 0, sent: 0, cancelled: 0 },
    ready: 0, retrying: 0, expiredLeases: 0, nextAttemptAt: null, recentFailures: [],
  },
};
