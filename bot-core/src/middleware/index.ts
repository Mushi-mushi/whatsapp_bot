import type { Logger } from "pino";
import type { SeenActivityStore, SeenStore, TellStore } from "../state/repos.js";
import type { RuntimeState } from "../state/runtime.js";
import type { Context } from "../router/context.js";
import type { Middleware } from "../router/router.js";
import { extractCommandToken, normalizeLooseName, normalizeName } from "../router/normalize.js";

// Skip our own outgoing messages, except commands the owner types from the linked
// phone (when enabled) and answers to an active game in the chat. The bot's own
// prefixed replies are always ignored to avoid loops.
export function ignoreOwn(runtime: RuntimeState): Middleware {
  return async (ctx, next) => {
    if (!ctx.msg.fromMe) {
      await next();
      return;
    }
    if (!ctx.config.respondToOwnCommands) return;
    const prefix = ctx.config.botReplyPrefix?.trim();
    if (prefix && ctx.text.trimStart().startsWith(prefix)) return;
    const gameActive =
      runtime.triviaGames.has(ctx.msg.chatId) || runtime.insultGames.has(ctx.msg.chatId);
    if (!extractCommandToken(ctx.text) && !gameActive) return;
    await next();
  };
}

// Only process approved chats. Matches the chat name (group subject / DM contact),
// or a phone number — robust for LID DMs where the saved name is hidden and only
// the phone (senderPn) is known. Own commands (fromMe) are always allowed.
export const approvedSenderGuard: Middleware = async (ctx, next) => {
  if (ctx.msg.fromMe) {
    await next();
    return;
  }
  const approvedRaw = ctx.config.approvedSenders;
  const approvedNames = new Set(approvedRaw.map(normalizeName));
  if (approvedNames.has(normalizeName(ctx.msg.chatName))) {
    await next();
    return;
  }
  const chatNumber = ctx.msg.chatId.split("@")[0].replace(/\D/g, "");
  const senderNumber = ctx.msg.senderId.split("@")[0].replace(/\D/g, "");
  const phoneNumber = ctx.msg.senderPhone;
  for (const entry of approvedRaw) {
    const digits = entry.replace(/\D/g, "");
    if (
      digits.length >= 6 &&
      (digits === chatNumber || digits === senderNumber || digits === phoneNumber)
    ) {
      await next();
      return;
    }
  }
};

// Idempotent dedup keyed on the WhatsApp message id alone. WhatsApp may deliver
// the same message under both LID and phone addressing (different chat ids), so a
// per-chat key would miss duplicates. Mark on first sight to also beat races.
export function dedupe(seen: SeenStore): Middleware {
  return async (ctx, next) => {
    const id = ctx.msg.messageId;
    if (id) {
      if (seen.has("msg", id)) return;
      seen.mark("msg", id);
    }
    await next();
  };
}

// Ignore media unless explicitly enabled in config, EXCEPT media whose caption
// carries a bot command (e.g. a photo captioned `bot.paint ...` for img2img).
export const mediaPolicy: Middleware = async (ctx, next) => {
  const k = ctx.msg.kind;
  if (k === "image" || k === "video" || k === "sticker") {
    const hasCommand = !!extractCommandToken(ctx.text);
    if (!hasCommand && !ctx.config.acknowledgeMedia) return;
  }
  await next();
};

// While on siesta, the bot ignores everything (matches the old Python behavior).
export function siestaGuard(runtime: RuntimeState): Middleware {
  return async (_ctx, next) => {
    if (runtime.isSleeping()) return;
    await next();
  };
}

// Record last-seen for the sender and deliver any pending "tell" messages to them.
export function activityTracker(seen: SeenActivityStore, tells: TellStore): Middleware {
  return async (ctx, next) => {
    const strictName = normalizeName(ctx.msg.senderName);
    const looseName = normalizeLooseName(ctx.msg.senderName);
    const phone = ctx.msg.senderPhone.replace(/\D/g, "");
    if (strictName) {
      seen.record(strictName, ctx.msg.senderName, Date.now(), ctx.msg.isGroup ? ctx.msg.chatName : null);
    }
    const keys = [...new Set([strictName, looseName, phone])].filter(Boolean);
    for (const key of keys) {
      for (const t of tells.takeFor(key)) {
        await ctx.reply(`📨 ${ctx.msg.senderName}, ${t.from_name} said: ${t.message}`);
      }
    }
    await next();
  };
}

export function logging(logger: Logger): Middleware {
  return async (ctx: Context, next) => {
    logger.info(
      {
        chat: ctx.msg.senderName,
        kind: ctx.msg.kind,
        id: ctx.msg.messageId,
        text: ctx.msg.text?.slice(0, 80),
      },
      "incoming",
    );
    await next();
  };
}
