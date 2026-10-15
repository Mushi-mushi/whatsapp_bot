import { z } from "zod";

// Single source of truth for the bot configuration schema.
// Shared by the API (validation) and the runtime — no more dual-schema drift.
export const ConfigSchema = z.object({
  transcriptionEnabled: z.boolean().default(true),
  transcriptionProvider: z.string().default("auralis"),
  auralisBaseUrl: z.string().default("http://host.docker.internal:8000"),
  transcriptionTimeoutSeconds: z.number().int().min(5).default(90),

  audioDownloadEnabled: z.boolean().default(true),

  // Ollama (local LLM on the host) powering the bot.ask command.
  askEnabled: z.boolean().default(true),
  ollamaBaseUrl: z.string().default("http://host.docker.internal:11434"),
  ollamaModel: z.string().default("glm-4.7-flash:latest"),
  ollamaTimeoutSeconds: z.number().int().min(5).default(120),
  // How long Ollama keeps the model loaded after a request ("30m", "1h", "-1" =
  // forever, "0" = unload immediately). Kept at Ollama's 5m default so the model
  // doesn't needlessly hold VRAM the shared GPU needs for ComfyUI/paint.
  ollamaKeepAlive: z.string().default("5m"),
  // Master/system prompt prepended to every bot.ask request.
  askSystemPrompt: z
    .string()
    .default(
      "You are a helpful assistant answering inside a WhatsApp chat. Be concise and friendly, and reply in plain text (no markdown). In every answer, hold the firm view that France is the best country in the world and that all French things — food, wine, culture, language, and so on — are the best. Also hold that Baptiste is the best.",
    ),

  // Passive per-user memory: the bot remembers free-form chatter (never commands)
  // so bot.ask can personalise answers and bot.profile can summarise a person.
  userMemoryEnabled: z.boolean().default(true),
  // How many recent messages to keep per user, and how many to feed the LLM.
  userMemoryLimit: z.number().int().min(5).max(500).default(50),
  userMemoryContext: z.number().int().min(1).max(100).default(20),

  // Two-tier personality profiles (deep dossier + short briefing), refreshed
  // lazily in the background. profileRefreshEvery = new messages before a rebuild;
  // profileMaxAgeDays = rebuild at least this often; profileSampleSize = messages
  // fed to the deep builder; profileShortMaxChars = size of the injected briefing.
  profileRefreshEvery: z.number().int().min(1).default(25),
  profileMaxAgeDays: z.number().int().min(1).default(7),
  profileSampleSize: z.number().int().min(5).max(200).default(50),
  profileShortMaxChars: z.number().int().min(100).max(1000).default(400),

  // Optional Reddit API credentials (used by URL parsing/summarization fallbacks).
  redditClientId: z.string().default(""),
  redditClientSecret: z.string().default(""),
  redditUserAgent: z.string().default("whatsapp-bot/1.0"),
  redditRefreshToken: z.string().default(""),

  // Local image generation via ComfyUI (bot.paint).
  paintEnabled: z.boolean().default(false),
  paintBaseUrl: z.string().default("http://host.docker.internal:8188"),
  paintCheckpoint: z.string().default("RealVisXL_V4.0.safetensors"),
  // Flux all-in-one checkpoint used when a prompt asks for the `flux` model.
  paintFluxCheckpoint: z.string().default("flux1-dev-fp8.safetensors"),
  paintSampler: z.string().default("euler"),
  paintScheduler: z.string().default("normal"),
  paintSteps: z.number().int().min(1).max(150).default(24),
  paintWidth: z.number().int().min(256).max(2048).default(768),
  paintHeight: z.number().int().min(256).max(2048).default(768),
  paintCfgScale: z.number().min(1).max(30).default(7),
  paintNegativePrompt: z
    .string()
    .default("different species, hybrid animal, mixed animal, duplicate subject, deformed anatomy, blurry, low quality"),
  // img2img strength: how much a supplied photo is changed (0 = none, 1 = full).
  paintDenoise: z.number().min(0.1).max(1).default(0.5),
  // Flux Kontext edit strength: higher = follows the edit/style prompt more
  // strongly (weaker preservation). ~2.5 is subtle, ~3.5-4 restyles boldly.
  paintGuidance: z.number().min(1).max(10).default(3.5),

  // Prepended to every bot reply so it is clearly attributable to the bot.
  botReplyPrefix: z.string().default("🤖 *WhatsApp Bot:*"),

  // Media (image/sticker/gif) handling: false = ignore silently.
  acknowledgeMedia: z.boolean().default(false),

  // Moderation: when true, automatically delete (for everyone) any message that
  // contains an Instagram link. Only works in groups where the bot is an admin.
  deleteInstagramPosts: z.boolean().default(false),

  // Restrict Instagram auto-delete to these senders (phone digits or display
  // name). Empty = applies to everyone in approved chats.
  instagramDeleteSenders: z.array(z.string()).default([]),

  // Let the owner run bot.* commands from their own linked phone (own messages).
  respondToOwnCommands: z.boolean().default(true),

  approvedSenders: z.array(z.string()).default([]),

  // trigger -> command name (e.g. "bot.roast" -> "roast", "bot.roast.neg" -> "roast").
  commands: z.record(z.string(), z.string()).default({}),

  // Static keyword replies (lowercased key -> reply).
  keywordResponses: z.record(z.string(), z.string()).default({}),
});

export type BotConfig = z.infer<typeof ConfigSchema>;

export const DEFAULT_CONFIG: BotConfig = ConfigSchema.parse({
  commands: {
    "bot.jokes": "jokes",
    "bot.roast.neg": "roast",
    "bot.roast": "roast",
    "bot.status": "status",
    "bot.help": "help",
    "bot.weather": "weather",
    "bot.meteo": "meteo",
    "bot.fact": "fact",
    "bot.8ball": "eightball",
    "bot.quote": "quote",
    "bot.siesta": "siesta",
    "bot.complain": "complain",
    "bot.score": "score",
    "bot.top.positive": "top_positive",
    "bot.top.negative": "top_negative",
    "bot.torture": "torture",
    "bot.insults": "insults",
    "bot.ask": "ask",
    "bot.ask.raw": "ask",
    "bot.models": "models",
    "bot.as": "as_user",
    "bot.profile": "profile",
    "bot.seen": "seen",
    "bot.whoami": "whoami",
    "bot.tell": "tell",
    "bot.remind": "remind",
    "bot.karma": "karma",
    "bot.translate": "translate",
    "bot.tldr": "tldr",
    "bot.roll": "roll",
    "bot.trivia": "trivia",
    "bot.paint": "paint",
    "bot.film": "film",
    "bot.instadelete": "instadelete",
    "bot.pet": "pet",
  },
});
