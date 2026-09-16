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

  // Prepended to every bot reply so it is clearly attributable to the bot.
  botReplyPrefix: z.string().default("🤖 *WhatsApp Bot:*"),

  // Media (image/sticker/gif) handling: false = ignore silently.
  acknowledgeMedia: z.boolean().default(false),

  // Approved chats/senders. Names are matched normalized (accent/emoji-insensitive).
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
  },
});
