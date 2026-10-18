import type { Handler } from "../../router/router.js";
import type { UserMemoryStore } from "../../state/repos.js";
import type { IncomingMessage } from "../../transport/types.js";
import type { ProfileService } from "../profiles/service.js";
import { ollamaChat, ollamaErrorMessage, ollamaListModels, type OllamaMessage } from "../../util/ollama.js";
import { chatKey, mentionedUsers, rememberMessage, senderKey, userContextBlock } from "./user-context.js";

// Pipe the user's prompt to a local Ollama model and reply with the answer.
// When user memory is enabled, the system prompt is enriched with what the bot
// knows about the asker (and anyone they mention) so answers feel personal.
export function makeAsk(userMemory: UserMemoryStore, profiler: ProfileService): Handler {
  return async (ctx) => {
    const cfg = ctx.config;
    if (!cfg.askEnabled) {
      await ctx.reply("The ask command is currently disabled.");
      return;
    }
    const prompt = ctx.args.trim();
    if (!prompt) {
      await ctx.reply("Ask me anything! Usage: `bot.ask What is the capital of France?`");
      return;
    }

    // `bot.ask models` / `model=?` lists what's installed so users can pick one.
    if (isModelListRequest(prompt)) {
      await ctx.reply(modelListReply(cfg.ollamaModel, await ollamaListModels(cfg)));
      return;
    }

    // Optional inline model override, e.g. `bot.ask model=llama3 <question>`.
    // Stripped from the prompt so it isn't sent to the LLM; falls back to config.
    const { model, text } = parseModel(prompt, cfg.ollamaModel);
    if (!text) {
      await ctx.reply("Ask me anything! Usage: `bot.ask What is the capital of France?`");
      return;
    }

    const system =
      cfg.askSystemPrompt?.trim() ||
      "You are a helpful assistant answering inside a WhatsApp chat. Be concise and friendly. Reply in plain text (no markdown).";

    const messages: OllamaMessage[] = [{ role: "system", content: system }];

    // bot.ask.raw answers without personalising from the learned user profiles.
    const useProfiles = cfg.userMemoryEnabled && !(ctx.commandTrigger ?? "").endsWith(".raw");
    const memory = buildMemoryPrompt(userMemory, profiler, useProfiles, cfg.userMemoryContext, {
      msg: ctx.msg,
      prompt: text,
    });
    if (memory) messages.push({ role: "system", content: memory });

    messages.push({ role: "user", content: text });

    const r = await ollamaChat(cfg, messages, { model });
    await ctx.reply(r.ok ? `🧠 ${r.content}` : ollamaErrorMessage(r, model));

    // The question itself is strong signal about the asker — record it (after the
    // answer, so it isn't fed into its own context) to enrich their profile.
    rememberMessage(userMemory, profiler, ctx.msg, cfg, `(asked the bot) ${text}`);
  };
}

// Inline `model=<name>` override for bot.ask, mirroring the paint command's
// token syntax. Returns the chosen model and the prompt with the token stripped.
// Model names may be quoted (for names with spaces) or bare (supporting Ollama
// tags like "glm-4.7-flash:latest").
function parseModel(prompt: string, fallback: string): { model: string; text: string } {
  const m = prompt.match(/(?:^|\s)model\s*=\s*(?:"([^"]+)"|'([^']+)'|(\S+))/i);
  if (!m) return { model: fallback, text: prompt };
  const chosen = (m[1] ?? m[2] ?? m[3]).trim();
  const text = prompt.replace(m[0], " ").replace(/\s{2,}/g, " ").trim();
  return { model: chosen || fallback, text };
}

// True when the prompt is asking to see the available models rather than asking
// a question (e.g. "models", "list model", "show models", "model=?").
function isModelListRequest(prompt: string): boolean {
  return /^(?:models?|(?:list|show|available|which|what)\s+(?:the\s+)?models?|model\s*=\s*(?:\?|list))$/i.test(
    prompt.trim(),
  );
}

// Formats the installed-model list for a chat reply, marking the current default.
function modelListReply(current: string, r: Awaited<ReturnType<typeof ollamaListModels>>): string {
  if (!r.ok) return "I couldn't reach Ollama to list the models. Make sure it's running on the host.";
  if (r.models.length === 0) return "No models are installed on Ollama yet.";
  const lines = r.models.map((m) => (m === current ? `• ${m} (default)` : `• ${m}`));
  return `🧠 Available models — pick one with \`bot.ask model=<name> <question>\`:\n${lines.join("\n")}`;
}

// Standalone `bot.models` command: list the models installed on Ollama. Unlike
// the `bot.ask models` shortcut, this never reaches the LLM, so the reply is
// always the real list rather than a hallucinated one.
export const models: Handler = async (ctx) => {
  const cfg = ctx.config;
  if (!cfg.askEnabled) {
    await ctx.reply("The ask command is currently disabled.");
    return;
  }
  await ctx.reply(modelListReply(cfg.ollamaModel, await ollamaListModels(cfg)));
};

// One line about a person: the compact profile briefing when one exists, else a
// few raw recent messages so brand-new users still get some personalization.
function personBlock(
  store: UserMemoryStore,
  profiler: ProfileService,
  key: string,
  displayName: string,
  role: string,
  contextLimit: number,
): string | null {
  const short = profiler.shortFor(key);
  if (short) return `About ${displayName} (${role}): ${short}`;
  return userContextBlock(store, key, displayName, contextLimit, role);
}

// Builds the optional "what the bot knows about these people" system message.
function buildMemoryPrompt(
  store: UserMemoryStore,
  profiler: ProfileService,
  enabled: boolean,
  contextLimit: number,
  input: { msg: IncomingMessage; prompt: string },
): string | null {
  if (!enabled) return null;
  const askerKey = senderKey(input.msg);
  const blocks: string[] = [];

  const askerName = input.msg.senderName?.trim() || "the person asking";
  const askerBlock = personBlock(store, profiler, askerKey, askerName, "the person asking", contextLimit);
  if (askerBlock) blocks.push(askerBlock);

  for (const u of mentionedUsers(store, input.prompt, askerKey, chatKey(input.msg))) {
    const block = personBlock(store, profiler, u.sender_key, u.name, "mentioned in the question", contextLimit);
    if (block) blocks.push(block);
  }

  if (blocks.length === 0) return null;
  return (
    "You have been chatting with these people. Use the notes below to make your answer more personal and relevant when it helps. " +
    "Do not quote the notes verbatim and do not mention that you have a record of their messages.\n\n" +
    blocks.join("\n\n")
  );
}
