import type { Logger } from "pino";
import type { SeenActivityStore, SeenStore, TellStore, UserMemoryStore } from "../state/repos.js";
import type { RuntimeState } from "../state/runtime.js";
import type { Context } from "../router/context.js";
import type { Middleware } from "../router/router.js";
import type { ProfileService } from "../handlers/profiles/service.js";
import type { PetService } from "../pets/service.js";
import { rememberMessage } from "../handlers/commands/user-context.js";
import { extractCommandToken, normalizeLooseName, normalizeName } from "../router/normalize.js";

// Passively learn from the owner's own messages so they build a profile like
// everyone else, and track their activity so others can `bot.seen` them. Runs
// before ignoreOwn (which would otherwise drop this chatter). Skips the bot's own
// prefixed replies and command inputs; the profile also skips very short noise.
export function learnFromOwner(
  userMemory: UserMemoryStore,
  profiler: ProfileService,
  seen: SeenActivityStore,
): Middleware {
  return async (ctx, next) => {
    if (ctx.msg.fromMe && !ctx.msg.isBot) {
      const text = ctx.text.trim();
      const prefix = ctx.config.botReplyPrefix?.trim();
      const isBotReply = !!prefix && text.startsWith(prefix);
      if (!isBotReply && !extractCommandToken(text)) {
        const strictName = normalizeName(ctx.msg.senderName);
        if (strictName) {
          seen.record(strictName, ctx.msg.senderName, Date.now(), ctx.msg.isGroup ? ctx.msg.chatName : null);
        }
        if (text.length >= 6) {
          rememberMessage(userMemory, profiler, ctx.msg, ctx.config, text);
        }
      }
    }
    await next();
  };
}

// Skip our own outgoing messages, except commands the owner types from the linked
// phone (when enabled) and answers to an active game in the chat. The bot's own
// prefixed replies are always ignored to avoid loops.
export function ignoreOwn(runtime: RuntimeState): Middleware {
  return async (ctx, next) => {
    if (ctx.msg.isBot) return;
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

export function petObserver(pets: PetService): Middleware {
  return async (ctx, next) => {
    pets.observe(ctx.msg);
    await next();
  };
}

export const approvedSenderGuard: Middleware = async (ctx, next) => {
  if (ctx.msg.fromMe) {
    await next();
    return;
  }
  for (const entry of ctx.config.approvedSenders) {
    const phone = ctx.msg.senderPhone;
    const matchesChat = entry.includes("@") && entry === ctx.msg.chatId;
    const matchesDm = !ctx.msg.isGroup && /^\d{6,15}$/.test(phone) &&
      (entry === `${phone}@s.whatsapp.net` || (/^\+?[\d ()-]+$/.test(entry) && entry.replace(/\D/g, "") === phone));
    if (matchesChat || matchesDm) {
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

// Matches any Instagram link (posts, reels, stories, profiles) in a message.
const INSTAGRAM_LINK = /\b(?:https?:\/\/)?(?:www\.)?(?:instagram\.com|instagr\.am)\/\S*/i;

// Instagram shares often arrive as a video/image link preview, so the URL lives
// in the caption or the preview metadata rather than the plain message text.
function instagramLinkText(ctx: Context): string {
  const parts: (string | null | undefined)[] = [ctx.text];
  const m = ctx.msg.raw.message;
  if (m) {
    const ext = m.extendedTextMessage;
    if (ext) parts.push(ext.text, ext.matchedText, ext.title, ext.description);
    parts.push(m.videoMessage?.caption, m.imageMessage?.caption);
    const ad =
      m.extendedTextMessage?.contextInfo?.externalAdReply ??
      m.videoMessage?.contextInfo?.externalAdReply ??
      m.imageMessage?.contextInfo?.externalAdReply;
    if (ad) parts.push(ad.sourceUrl, ad.title, ad.body);
  }
  return parts.filter(Boolean).join(" ");
}

// Does the message's sender match one of the configured targets? An empty target
// list means "everyone". Entries may be a JID, a phone number, or a display name.
function matchesInstagramTarget(ctx: Context, targets: string[]): boolean {
  if (targets.length === 0) return true;
  const phone = ctx.msg.senderPhone.replace(/\D/g, "");
  const nameNorm = normalizeName(ctx.msg.senderName);
  for (const raw of targets) {
    const entry = raw.trim();
    if (!entry) continue;
    if (entry.includes("@")) {
      if (entry === ctx.msg.senderId || (phone && entry === `${phone}@s.whatsapp.net`)) return true;
      continue;
    }
    const digits = entry.replace(/\D/g, "");
    if (/^\+?[\d ()-]+$/.test(entry) && digits.length >= 6) {
      if (digits === phone) return true;
      continue;
    }
    if (nameNorm && normalizeName(entry) === nameNorm) return true;
  }
  return false;
}

// Moderation: delete (for everyone) any message containing an Instagram link when
// enabled, optionally restricted to specific senders. Deletion only succeeds in
// groups where the bot is an admin (or on the bot's own messages); failures are
// logged and otherwise ignored.
export function instagramGuard(logger: Logger): Middleware {
  return async (ctx, next) => {
    if (
      ctx.config.deleteInstagramPosts &&
      INSTAGRAM_LINK.test(instagramLinkText(ctx)) &&
      matchesInstagramTarget(ctx, ctx.config.instagramDeleteSenders)
    ) {
      try {
        await ctx.deleteMessage();
        logger.info(
          { chat: ctx.msg.chatName, sender: ctx.msg.senderName },
          "deleted Instagram post",
        );
      } catch (err) {
        logger.warn({ err }, "failed to delete Instagram post (bot may not be group admin)");
      }
      return;
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

// Siesta pauses ordinary bot commands but leaves the group pet available.
export function siestaGuard(runtime: RuntimeState): Middleware {
  return async (ctx, next) => {
    if (runtime.isSleeping()) {
      const command = extractCommandToken(ctx.text)?.split(/\s+/, 1)[0].toLowerCase();
      const isPetCommand = command != null &&
        Object.entries(ctx.config.commands).some(
          ([trigger, name]) => name === "pet" && trigger.toLowerCase() === command,
        );
      if (!isPetCommand) return;
    }
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
      tells.enqueueFor(key, ctx.msg.chatId, ctx.msg.senderName);
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
      },
      "incoming",
    );
    await next();
  };
}
