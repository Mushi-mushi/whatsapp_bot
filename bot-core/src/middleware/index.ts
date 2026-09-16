import type { Logger } from "pino";
import type { SeenStore } from "../state/repos.js";
import type { RuntimeState } from "../state/runtime.js";
import type { Context } from "../router/context.js";
import type { Middleware } from "../router/router.js";
import { normalizeName } from "../router/normalize.js";

// Skip our own outgoing messages entirely (Baileys tells us via key.fromMe).
export const ignoreOwn: Middleware = async (ctx, next) => {
  if (ctx.msg.fromMe) return;
  await next();
};

// Only process approved chats. Matches the chat name (group subject / DM contact),
// or a phone number — robust for LID DMs where the saved name is hidden and only
// the phone (senderPn) is known.
export const approvedSenderGuard: Middleware = async (ctx, next) => {
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

// Idempotent dedup keyed by the stable chat JID + protocol message id.
export function dedupe(seen: SeenStore): Middleware {
  return async (ctx, next) => {
    const key = ctx.msg.chatId;
    if (ctx.msg.messageId && seen.has(key, ctx.msg.messageId)) return;
    await next();
    if (ctx.msg.messageId) seen.mark(key, ctx.msg.messageId);
  };
}

// Ignore media unless explicitly enabled in config.
export const mediaPolicy: Middleware = async (ctx, next) => {
  const k = ctx.msg.kind;
  if ((k === "image" || k === "video" || k === "sticker") && !ctx.config.acknowledgeMedia) {
    return;
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
