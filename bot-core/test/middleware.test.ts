import { describe, it, expect, vi } from "vitest";
import {
  approvedSenderGuard,
  dedupe,
  ignoreOwn,
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

function makeCtx(
  msgOverrides: Partial<IncomingMessage> = {},
  configOverrides: Partial<BotConfig> = {},
): { ctx: Context; sendText: ReturnType<typeof vi.fn> } {
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
    raw: {} as WAMessage,
    ...msgOverrides,
  };
  const sendText = vi.fn(async () => {});
  const services: Services = {
    transport: { sendText } as unknown as Services["transport"],
    getConfig: () => ({ ...DEFAULT_CONFIG, ...configOverrides }),
  };
  return { ctx: new Context(msg, services), sendText };
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
