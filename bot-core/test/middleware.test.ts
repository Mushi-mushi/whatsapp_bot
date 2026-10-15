import { describe, it, expect, vi } from "vitest";
import {
  approvedSenderGuard,
  dedupe,
  ignoreOwn,
  instagramGuard,
  learnFromOwner,
  mediaPolicy,
  siestaGuard,
} from "../src/middleware/index.js";
import { Context, type Services } from "../src/router/context.js";
import { DEFAULT_CONFIG, type BotConfig } from "../src/config/schema.js";
import { RuntimeState } from "../src/state/runtime.js";
import { openDatabase } from "../src/state/db.js";
import { SeenStore } from "../src/state/repos.js";
import type { IncomingMessage, MessageKind } from "../src/transport/types.js";
import type { WAMessage } from "@whiskeysockets/baileys";
import type { Logger } from "pino";

const silentLogger = { info: () => {}, warn: () => {}, error: () => {} } as unknown as Logger;

function makeCtx(
  msgOverrides: Partial<IncomingMessage> = {},
  configOverrides: Partial<BotConfig> = {},
): { ctx: Context; sendText: ReturnType<typeof vi.fn>; deleteMessage: ReturnType<typeof vi.fn> } {
  const kind: MessageKind = msgOverrides.kind ?? "text";
  const msg: IncomingMessage = {
    chatId: "c@s.whatsapp.net",
    chatName: "Alice",
    senderId: "c@s.whatsapp.net",
    senderName: "Alice",
    senderPhone: "34696451685",
    messageId: "m1",
    fromMe: false,
    isGroup: false,
    text: kind === "text" ? "hello" : null,
    kind,
    timestamp: Date.now(),
    raw: { key: { id: "m1", remoteJid: "c@s.whatsapp.net" } } as WAMessage,
    ...msgOverrides,
  };
  const sendText = vi.fn(async () => {});
  const deleteMessage = vi.fn(async () => {});
  const services: Services = {
    transport: { sendText, deleteMessage } as unknown as Services["transport"],
    getConfig: () => ({ ...DEFAULT_CONFIG, ...configOverrides }),
  };
  return { ctx: new Context(msg, services), sendText, deleteMessage };
}

const nextSpy = () => {
  const called = { value: false };
  const next = async () => {
    called.value = true;
  };
  return { next, called };
};

describe("approvedSenderGuard", () => {
  it("allows an approved chat by ID even after a rename", async () => {
    const { ctx } = makeCtx({ chatName: "Renamed" }, { approvedSenders: ["c@s.whatsapp.net"] });
    const { next, called } = nextSpy();
    await approvedSenderGuard(ctx, next);
    expect(called.value).toBe(true);
  });

  it("allows an approved sender by phone number", async () => {
    const { ctx } = makeCtx(
      { chatName: "Baptiste", senderPhone: "34696451685" },
      { approvedSenders: ["34696451685"] },
    );
    const { next, called } = nextSpy();
    await approvedSenderGuard(ctx, next);
    expect(called.value).toBe(true);
  });

  it("blocks an unapproved chat", async () => {
    const { ctx } = makeCtx({ chatName: "Stranger" }, { approvedSenders: ["alice"] });
    const { next, called } = nextSpy();
    await approvedSenderGuard(ctx, next);
    expect(called.value).toBe(false);
  });

  it("rejects a spoofed approved display name", async () => {
    const { ctx } = makeCtx({ chatName: "Alice" }, { approvedSenders: ["Alice"] });
    const { next, called } = nextSpy();
    await approvedSenderGuard(ctx, next);
    expect(called.value).toBe(false);
  });

  it("does not grant group access through a participant phone", async () => {
    const { ctx } = makeCtx({ isGroup: true, chatId: "group@g.us" }, { approvedSenders: ["34696451685"] });
    const { next, called } = nextSpy();
    await approvedSenderGuard(ctx, next);
    expect(called.value).toBe(false);
  });

  it("matches a phone JID to a verified LID direct conversation", async () => {
    const { ctx } = makeCtx({ chatId: "opaque@lid" }, { approvedSenders: ["34696451685@s.whatsapp.net"] });
    const { next, called } = nextSpy();
    await approvedSenderGuard(ctx, next);
    expect(called.value).toBe(true);
  });

  it("always allows the owner's own messages (fromMe)", async () => {
    const { ctx } = makeCtx({ fromMe: true, chatName: "Owner" }, { approvedSenders: [] });
    const { next, called } = nextSpy();
    await approvedSenderGuard(ctx, next);
    expect(called.value).toBe(true);
  });
});

describe("ignoreOwn", () => {
  it("passes through incoming (not-fromMe) messages", async () => {
    const runtime = new RuntimeState();
    const { ctx } = makeCtx({ fromMe: false });
    const { next, called } = nextSpy();
    await ignoreOwn(runtime)(ctx, next);
    expect(called.value).toBe(true);
  });

  it("allows the owner's own command when enabled", async () => {
    const runtime = new RuntimeState();
    const { ctx } = makeCtx({ fromMe: true, text: "bot.status" });
    const { next, called } = nextSpy();
    await ignoreOwn(runtime)(ctx, next);
    expect(called.value).toBe(true);
  });

  it("drops the owner's own non-command chatter", async () => {
    const runtime = new RuntimeState();
    const { ctx } = makeCtx({ fromMe: true, text: "just talking" });
    const { next, called } = nextSpy();
    await ignoreOwn(runtime)(ctx, next);
    expect(called.value).toBe(false);
  });

  it("ignores the bot's own prefixed replies to avoid loops", async () => {
    const runtime = new RuntimeState();
    const { ctx } = makeCtx({ fromMe: true, text: "🤖 *WhatsApp Bot:*\nbot.status" });
    const { next, called } = nextSpy();
    await ignoreOwn(runtime)(ctx, next);
    expect(called.value).toBe(false);
  });

  it("drops own commands when respondToOwnCommands is off", async () => {
    const runtime = new RuntimeState();
    const { ctx } = makeCtx({ fromMe: true, text: "bot.status" }, { respondToOwnCommands: false });
    const { next, called } = nextSpy();
    await ignoreOwn(runtime)(ctx, next);
    expect(called.value).toBe(false);
  });
});

describe("learnFromOwner", () => {
  const stubProfiler = () => ({ maybeRefresh: vi.fn() });
  const stubMemory = () => ({ record: vi.fn() });
  const stubSeen = () => ({ record: vi.fn() });

  it("records the owner's own chatter", async () => {
    const memory = stubMemory();
    const profiler = stubProfiler();
    const seen = stubSeen();
    const { ctx } = makeCtx({ fromMe: true, text: "I love climbing on weekends", senderName: "Baptiste" });
    const { next, called } = nextSpy();
    await learnFromOwner(memory as never, profiler as never, seen as never)(ctx, next);
    expect(memory.record).toHaveBeenCalledOnce();
    expect(profiler.maybeRefresh).toHaveBeenCalledOnce();
    expect(called.value).toBe(true);
  });

  it("tracks activity so others can bot.seen the owner", async () => {
    const memory = stubMemory();
    const profiler = stubProfiler();
    const seen = stubSeen();
    const { ctx } = makeCtx({ fromMe: true, text: "heading out climbing", senderName: "Baptiste" });
    const { next } = nextSpy();
    await learnFromOwner(memory as never, profiler as never, seen as never)(ctx, next);
    expect(seen.record).toHaveBeenCalledWith("baptiste", "Baptiste", expect.any(Number), null);
  });

  it("tracks short activity but does not add it to the profile", async () => {
    const memory = stubMemory();
    const profiler = stubProfiler();
    const seen = stubSeen();
    const { ctx } = makeCtx({ fromMe: true, text: "ok", senderName: "Baptiste" });
    const { next } = nextSpy();
    await learnFromOwner(memory as never, profiler as never, seen as never)(ctx, next);
    expect(seen.record).toHaveBeenCalledOnce();
    expect(memory.record).not.toHaveBeenCalled();
  });

  it("skips the bot's own prefixed replies", async () => {
    const memory = stubMemory();
    const profiler = stubProfiler();
    const seen = stubSeen();
    const { ctx } = makeCtx({ fromMe: true, text: "🤖 *WhatsApp Bot:*\nBaptiste was last seen 17d ago." });
    const { next, called } = nextSpy();
    await learnFromOwner(memory as never, profiler as never, seen as never)(ctx, next);
    expect(memory.record).not.toHaveBeenCalled();
    expect(seen.record).not.toHaveBeenCalled();
    expect(called.value).toBe(true);
  });

  it("skips the owner's own command inputs", async () => {
    const memory = stubMemory();
    const profiler = stubProfiler();
    const seen = stubSeen();
    const { ctx } = makeCtx({ fromMe: true, text: "bot.seen baptiste" });
    const { next, called } = nextSpy();
    await learnFromOwner(memory as never, profiler as never, seen as never)(ctx, next);
    expect(memory.record).not.toHaveBeenCalled();
    expect(seen.record).not.toHaveBeenCalled();
    expect(called.value).toBe(true);
  });

  it("ignores messages from other people", async () => {
    const memory = stubMemory();
    const profiler = stubProfiler();
    const seen = stubSeen();
    const { ctx } = makeCtx({ fromMe: false, text: "I love climbing on weekends" });
    const { next, called } = nextSpy();
    await learnFromOwner(memory as never, profiler as never, seen as never)(ctx, next);
    expect(memory.record).not.toHaveBeenCalled();
    expect(seen.record).not.toHaveBeenCalled();
    expect(called.value).toBe(true);
  });
});

describe("mediaPolicy", () => {
  it("ignores media without a command when acknowledgeMedia is off", async () => {
    const { ctx } = makeCtx({ kind: "image", text: null }, { acknowledgeMedia: false });
    const { next, called } = nextSpy();
    await mediaPolicy(ctx, next);
    expect(called.value).toBe(false);
  });

  it("lets media with a command caption through (img2img)", async () => {
    const { ctx } = makeCtx({ kind: "image", text: "bot.paint a cat" }, { acknowledgeMedia: false });
    const { next, called } = nextSpy();
    await mediaPolicy(ctx, next);
    expect(called.value).toBe(true);
  });

  it("always lets text through", async () => {
    const { ctx } = makeCtx({ kind: "text", text: "hi" });
    const { next, called } = nextSpy();
    await mediaPolicy(ctx, next);
    expect(called.value).toBe(true);
  });
});

describe("siestaGuard", () => {
  it("allows pet commands during siesta", async () => {
    const runtime = new RuntimeState();
    runtime.siestaUntil = Date.now() + 60_000;
    const { ctx } = makeCtx({ isGroup: true, text: "bot.pet feed" });
    const { next, called } = nextSpy();
    await siestaGuard(runtime)(ctx, next);
    expect(called.value).toBe(true);
  });

  it("continues to block other commands and ordinary messages during siesta", async () => {
    const runtime = new RuntimeState();
    runtime.siestaUntil = Date.now() + 60_000;
    for (const text of ["bot.ask What time is it?", "hello"]) {
      const { ctx } = makeCtx({ text });
      const { next, called } = nextSpy();
      await siestaGuard(runtime)(ctx, next);
      expect(called.value).toBe(false);
    }
  });

  it("allows all messages when siesta has ended", async () => {
    const runtime = new RuntimeState();
    runtime.siestaUntil = Date.now() - 1;
    const { ctx } = makeCtx({ text: "hello" });
    const { next, called } = nextSpy();
    await siestaGuard(runtime)(ctx, next);
    expect(called.value).toBe(true);
  });
});

describe("instagramGuard", () => {
  it("deletes a message with an Instagram link when enabled", async () => {
    const { ctx, deleteMessage } = makeCtx(
      { text: "look at this https://www.instagram.com/p/ABC123/" },
      { deleteInstagramPosts: true },
    );
    const { next, called } = nextSpy();
    await instagramGuard(silentLogger)(ctx, next);
    expect(deleteMessage).toHaveBeenCalledOnce();
    expect(called.value).toBe(false);
  });

  it("matches reel, story and instagr.am short links", async () => {
    for (const link of [
      "https://instagram.com/reel/XYZ",
      "instagram.com/stories/user/123",
      "https://instagr.am/p/ABC",
    ]) {
      const { ctx, deleteMessage } = makeCtx({ text: link }, { deleteInstagramPosts: true });
      const { next } = nextSpy();
      await instagramGuard(silentLogger)(ctx, next);
      expect(deleteMessage).toHaveBeenCalledOnce();
    }
  });

  it("leaves messages alone when disabled", async () => {
    const { ctx, deleteMessage } = makeCtx(
      { text: "https://www.instagram.com/p/ABC123/" },
      { deleteInstagramPosts: false },
    );
    const { next, called } = nextSpy();
    await instagramGuard(silentLogger)(ctx, next);
    expect(deleteMessage).not.toHaveBeenCalled();
    expect(called.value).toBe(true);
  });

  it("ignores non-Instagram links", async () => {
    const { ctx, deleteMessage } = makeCtx(
      { text: "check https://example.com/instagram" },
      { deleteInstagramPosts: true },
    );
    const { next, called } = nextSpy();
    await instagramGuard(silentLogger)(ctx, next);
    expect(deleteMessage).not.toHaveBeenCalled();
    expect(called.value).toBe(true);
  });

  it("passes through when deletion fails (e.g. bot not admin)", async () => {
    const { ctx, deleteMessage } = makeCtx(
      { text: "https://www.instagram.com/p/ABC123/" },
      { deleteInstagramPosts: true },
    );
    deleteMessage.mockRejectedValueOnce(new Error("not admin"));
    const { next, called } = nextSpy();
    await instagramGuard(silentLogger)(ctx, next);
    expect(deleteMessage).toHaveBeenCalledOnce();
    expect(called.value).toBe(false);
  });

  it("only deletes from a targeted sender (by phone)", async () => {
    const link = "https://www.instagram.com/p/ABC123/";
    const targets = { deleteInstagramPosts: true, instagramDeleteSenders: ["34696451685"] };

    const hit = makeCtx({ text: link, senderPhone: "34696451685" }, targets);
    await instagramGuard(silentLogger)(hit.ctx, async () => {});
    expect(hit.deleteMessage).toHaveBeenCalledOnce();

    const miss = makeCtx({ text: link, senderPhone: "99999999999" }, targets);
    const { next, called } = nextSpy();
    await instagramGuard(silentLogger)(miss.ctx, next);
    expect(miss.deleteMessage).not.toHaveBeenCalled();
    expect(called.value).toBe(true);
  });

  it("matches a targeted sender by display name", async () => {
    const { ctx, deleteMessage } = makeCtx(
      { text: "https://instagram.com/reel/x", senderName: "Bob" },
      { deleteInstagramPosts: true, instagramDeleteSenders: ["bob"] },
    );
    await instagramGuard(silentLogger)(ctx, async () => {});
    expect(deleteMessage).toHaveBeenCalledOnce();
  });

  it("detects a link in a video-preview caption (kind video, no text)", async () => {
    const { ctx, deleteMessage } = makeCtx(
      {
        kind: "video",
        text: null,
        raw: {
          key: { id: "m1", remoteJid: "g@g.us" },
          message: { videoMessage: { caption: "https://www.instagram.com/reel/Dabc/?x=1" } },
        } as unknown as WAMessage,
      },
      { deleteInstagramPosts: true },
    );
    await instagramGuard(silentLogger)(ctx, async () => {});
    expect(deleteMessage).toHaveBeenCalledOnce();
  });

  it("detects a link in extendedText preview metadata", async () => {
    const { ctx, deleteMessage } = makeCtx(
      {
        text: "check this out",
        raw: {
          key: { id: "m1", remoteJid: "g@g.us" },
          message: {
            extendedTextMessage: {
              text: "check this out",
              matchedText: "https://instagram.com/p/Dabc",
            },
          },
        } as unknown as WAMessage,
      },
      { deleteInstagramPosts: true },
    );
    await instagramGuard(silentLogger)(ctx, async () => {});
    expect(deleteMessage).toHaveBeenCalledOnce();
  });
});

describe("siestaGuard", () => {
  it("blocks everything while sleeping", async () => {
    const runtime = new RuntimeState();
    runtime.siestaUntil = Date.now() + 60_000;
    const { ctx } = makeCtx();
    const { next, called } = nextSpy();
    await siestaGuard(runtime)(ctx, next);
    expect(called.value).toBe(false);
  });

  it("passes through when not sleeping", async () => {
    const runtime = new RuntimeState();
    const { ctx } = makeCtx();
    const { next, called } = nextSpy();
    await siestaGuard(runtime)(ctx, next);
    expect(called.value).toBe(true);
  });
});

describe("dedupe", () => {
  it("drops a message id seen before", async () => {
    const db = openDatabase(":memory:");
    const seen = new SeenStore(db);
    const mw = dedupe(seen);

    const first = makeCtx({ messageId: "dup-1" });
    const r1 = nextSpy();
    await mw(first.ctx, r1.next);
    expect(r1.called.value).toBe(true);

    const second = makeCtx({ messageId: "dup-1" });
    const r2 = nextSpy();
    await mw(second.ctx, r2.next);
    expect(r2.called.value).toBe(false);
  });
});
