import type { Handler } from "../../router/router.js";
import type { UserMemoryStore } from "../../state/repos.js";
import type { IncomingMessage } from "../../transport/types.js";
import type { ProfileService } from "../profiles/service.js";
import { ollamaChat, ollamaErrorMessage, type OllamaMessage } from "../../util/ollama.js";
import { mentionedUsers, senderKey, userContextBlock } from "./user-context.js";

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

    const system =
      cfg.askSystemPrompt?.trim() ||
      "You are a helpful assistant answering inside a WhatsApp chat. Be concise and friendly. Reply in plain text (no markdown).";

    const messages: OllamaMessage[] = [{ role: "system", content: system }];

    const memory = buildMemoryPrompt(userMemory, profiler, cfg.userMemoryEnabled, cfg.userMemoryContext, {
      msg: ctx.msg,
      prompt,
    });
    if (memory) messages.push({ role: "system", content: memory });

    messages.push({ role: "user", content: prompt });

    const r = await ollamaChat(cfg, messages);
    await ctx.reply(r.ok ? `🧠 ${r.content}` : ollamaErrorMessage(r, cfg.ollamaModel));
  };
}

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

  for (const u of mentionedUsers(store, input.prompt, askerKey)) {
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
