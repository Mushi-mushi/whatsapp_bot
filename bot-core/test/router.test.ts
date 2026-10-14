import { describe, it, expect } from "vitest";
import { Bot } from "../src/router/router.js";
import { BackgroundJobs } from "../src/router/jobs.js";
import { Context, type Services } from "../src/router/context.js";
import { DEFAULT_CONFIG } from "../src/config/schema.js";
import type { IncomingMessage, MessageKind } from "../src/transport/types.js";
import type { WAMessage } from "@whiskeysockets/baileys";

function makeCtx(text: string, kind: MessageKind = "text"): Context {
  const msg: IncomingMessage = {
    chatId: "c@s.whatsapp.net",
    chatName: "Alice",
    senderId: "c@s.whatsapp.net",
    senderName: "Alice",
    senderPhone: "12345678",
    messageId: "m1",
    fromMe: false,
    isGroup: false,
    text: kind === "text" ? text : null,
    kind,
    timestamp: Date.now(),
    raw: {} as WAMessage,
  };
  const services: Services = {
    transport: {} as Services["transport"],
    getConfig: () => DEFAULT_CONFIG,
  };
  return new Context(msg, services);
}

describe("Bot router dispatch", () => {
  it("prefers the longest matching trigger", async () => {
    const bot = new Bot();
    const hits: string[] = [];
    bot.command("bot.roast", () => void hits.push("roast"));
    bot.command("bot.roast.neg", () => void hits.push("roast.neg"));

    await bot.handle(makeCtx("bot.roast.neg"));
    expect(hits).toEqual(["roast.neg"]);
  });

  it("passes trailing text as command args", async () => {
    const bot = new Bot();
    let args = "<unset>";
    bot.command("bot.ask", (ctx) => {
      args = ctx.args;
    });

    await bot.handle(makeCtx("bot.ask hello world"));
    expect(args).toBe("hello world");
  });

  it("extracts a command from a group-prefixed line with a trailing time", async () => {
    const bot = new Bot();
    const hits: string[] = [];
    bot.command("bot.status", () => void hits.push("status"));

    await bot.handle(makeCtx("Alice bot.status 14:02"));
    expect(hits).toEqual(["status"]);
  });

  it("falls back to hears when no command matches", async () => {
    const bot = new Bot();
    const hits: string[] = [];
    bot.command("bot.status", () => void hits.push("cmd"));
    bot.hears(/hello/i, () => void hits.push("hears"));

    await bot.handle(makeCtx("well hello there"));
    expect(hits).toEqual(["hears"]);
  });

  it("prefers a command over a matching hears pattern", async () => {
    const bot = new Bot();
    const hits: string[] = [];
    bot.command("bot.status", () => void hits.push("cmd"));
    bot.hears(/bot\.status/i, () => void hits.push("hears"));

    await bot.handle(makeCtx("bot.status"));
    expect(hits).toEqual(["cmd"]);
  });

  it("runs the fallback when nothing else matches", async () => {
    const bot = new Bot();
    let ran = false;
    bot.fallback(() => {
      ran = true;
    });

    await bot.handle(makeCtx("just chatting"));
    expect(ran).toBe(true);
  });

  it("routes non-text messages to their kind handler", async () => {
    const bot = new Bot();
    const hits: string[] = [];
    bot.on("audio", () => void hits.push("audio"));
    bot.fallback(() => void hits.push("fallback"));

    await bot.handle(makeCtx("", "audio"));
    expect(hits).toEqual(["audio"]);
  });

  it("runs middleware in order before dispatch and can short-circuit", async () => {
    const bot = new Bot();
    const order: string[] = [];
    bot.use(async (_ctx, next) => {
      order.push("mw1");
      await next();
    });
    bot.use(async () => {
      order.push("mw2-stop"); // does not call next()
    });
    bot.command("bot.status", () => void order.push("handler"));

    await bot.handle(makeCtx("bot.status"));
    expect(order).toEqual(["mw1", "mw2-stop"]);
  });

  it("clearCommands removes all registered commands", async () => {
    const bot = new Bot();
    const hits: string[] = [];
    bot.command("bot.status", () => void hits.push("cmd"));
    bot.fallback(() => void hits.push("fallback"));
    bot.clearCommands();

    await bot.handle(makeCtx("bot.status"));
    expect(hits).toEqual(["fallback"]);
  });

  it("serializes each chat while other chats can progress", async () => {
    const bot = new Bot();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const order: string[] = [];
    bot.fallback(async (ctx) => {
      order.push(ctx.text);
      if (ctx.text === "first") await gate;
    });
    const first = bot.handle(makeCtx("first"));
    const second = bot.handle(makeCtx("second"));
    const other = makeCtx("other");
    other.msg.chatId = "other-chat";
    await bot.handle(other);
    expect(order).toEqual(["first", "other"]);
    release();
    await Promise.all([first, second]);
    expect(order).toEqual(["first", "other", "second"]);
    await bot.stop();
    await expect(bot.handle(makeCtx("late"))).rejects.toThrow("unavailable");
  });
});

describe("background jobs", () => {
  it("bounds work, rejects duplicate chat jobs, and drains on stop", async () => {
    const queue = new BackgroundJobs(() => {}, 2);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const completed: string[] = [];
    expect(queue.submit("chat", async () => { await gate; completed.push("first"); })).toBe(true);
    expect(queue.submit("chat", async () => {})).toBe(false);
    expect(queue.submit("other", async () => { completed.push("second"); })).toBe(true);
    expect(queue.submit("third", async () => {})).toBe(false);
    const draining = queue.stop();
    expect(queue.submit("late", async () => {})).toBe(false);
    release();
    await draining;
    expect(completed).toEqual(["first", "second"]);
  });

  it("continues after a failed job", async () => {
    const errors: unknown[] = [];
    const queue = new BackgroundJobs((error) => { errors.push(error); });
    let ran = false;
    queue.submit("first", async () => { throw new Error("failed"); });
    queue.submit("second", async () => { ran = true; });
    await queue.stop();
    expect(errors).toHaveLength(1);
    expect(ran).toBe(true);
  });

  it("queues a few jobs per key (FIFO) and rejects beyond the limit", async () => {
    const queue = new BackgroundJobs(() => {});
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const order: string[] = [];
    // First runs and blocks; two more queue behind it; the fourth exceeds maxPerKey=3.
    expect(queue.submit("chat", async () => { await gate; order.push("a"); }, 3)).toBe(true);
    expect(queue.submit("chat", async () => { order.push("b"); }, 3)).toBe(true);
    expect(queue.submit("chat", async () => { order.push("c"); }, 3)).toBe(true);
    expect(queue.submit("chat", async () => { order.push("d"); }, 3)).toBe(false);
    release();
    await queue.stop();
    expect(order).toEqual(["a", "b", "c"]);
  });
});
