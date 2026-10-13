import { describe, it, expect, vi } from "vitest";
import { makeInstaDelete } from "../src/handlers/commands/instadelete.js";
import { Context, type Services } from "../src/router/context.js";
import { DEFAULT_CONFIG, type BotConfig } from "../src/config/schema.js";
import type { ConfigController } from "../src/config/controller.js";
import type { IncomingMessage } from "../src/transport/types.js";
import type { WAMessage } from "@whiskeysockets/baileys";

function setup(
  args: string,
  fromMe: boolean,
  initial: Partial<BotConfig> = {},
  raw: Partial<WAMessage> = {},
): {
  run: () => unknown;
  reply: ReturnType<typeof vi.fn>;
  update: ReturnType<typeof vi.fn>;
  state: () => BotConfig;
} {
  let cfg: BotConfig = { ...DEFAULT_CONFIG, ...initial };
  const update = vi.fn((patch: Partial<BotConfig>) => {
    cfg = { ...cfg, ...patch };
    return cfg;
  });
  const settings: ConfigController = { get: () => cfg, update };
  const msg: IncomingMessage = {
    chatId: "c@s.whatsapp.net",
    chatName: "Group",
    senderId: "s",
    senderName: "Owner",
    senderPhone: "123",
    messageId: "m1",
    fromMe,
    isGroup: true,
    text: `bot.instadelete ${args}`,
    kind: "text",
    timestamp: Date.now(),
    raw: { ...raw } as WAMessage,
  };
  const reply = vi.fn(async () => {});
  const services: Services = {
    transport: { sendText: reply } as unknown as Services["transport"],
    getConfig: () => cfg,
  };
  const ctx = new Context(msg, services);
  ctx.args = args;
  const handler = makeInstaDelete(settings);
  return { run: () => handler(ctx), reply, update, state: () => cfg };
}

const text = (reply: ReturnType<typeof vi.fn>) => reply.mock.calls[0][1] as string;

describe("bot.instadelete on/off/status", () => {
  it("enables the mode for the owner", async () => {
    const { run, update, reply } = setup("on", true, { deleteInstagramPosts: false });
    await run();
    expect(update).toHaveBeenCalledWith({ deleteInstagramPosts: true });
    expect(text(reply)).toMatch(/now \*ON\*/);
  });

  it("disables the mode for the owner", async () => {
    const { run, update, reply } = setup("off", true, { deleteInstagramPosts: true });
    await run();
    expect(update).toHaveBeenCalledWith({ deleteInstagramPosts: false });
    expect(text(reply)).toMatch(/now \*OFF\*/);
  });

  it("reports status without changing anything", async () => {
    const { run, update, reply } = setup("status", true, { deleteInstagramPosts: true });
    await run();
    expect(update).not.toHaveBeenCalled();
    expect(text(reply)).toMatch(/\*ON\* for everyone/);
  });

  it("is a no-op when already in the requested state", async () => {
    const { run, update, reply } = setup("on", true, { deleteInstagramPosts: true });
    await run();
    expect(update).not.toHaveBeenCalled();
    expect(text(reply)).toMatch(/already \*ON\*/);
  });

  it("refuses non-owner callers", async () => {
    const { run, update, reply } = setup("on", false);
    await run();
    expect(update).not.toHaveBeenCalled();
    expect(text(reply)).toMatch(/owner/i);
  });

  it("rejects an unknown argument", async () => {
    const { run, update, reply } = setup("maybe", true);
    await run();
    expect(update).not.toHaveBeenCalled();
    expect(text(reply)).toMatch(/bot\.instadelete/);
  });
});

describe("bot.instadelete target list", () => {
  it("adds a targeted sender and auto-enables the mode", async () => {
    const { run, update, state } = setup("add 34600111222", true);
    await run();
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({ instagramDeleteSenders: ["34600111222"], deleteInstagramPosts: true }),
    );
    expect(state().instagramDeleteSenders).toEqual(["34600111222"]);
    expect(state().deleteInstagramPosts).toBe(true);
  });

  it("adds the quoted sender when replying with no argument", async () => {
    const { run, update } = setup("add", true, {}, {
      message: {
        extendedTextMessage: {
          text: "bot.instadelete add",
          contextInfo: { participant: "49999@s.whatsapp.net" },
        },
      },
    } as Partial<WAMessage>);
    await run();
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({ instagramDeleteSenders: ["49999@s.whatsapp.net"] }),
    );
  });

  it("does not add a duplicate (same phone digits)", async () => {
    const { run, update, reply } = setup("add +34 600 111 222", true, {
      deleteInstagramPosts: true,
      instagramDeleteSenders: ["34600111222"],
    });
    await run();
    expect(update).not.toHaveBeenCalled();
    expect(text(reply)).toMatch(/already targeted/);
  });

  it("removes a targeted sender by phone", async () => {
    const { run, update } = setup("remove 34600111222", true, {
      instagramDeleteSenders: ["34600111222", "Bob"],
    });
    await run();
    expect(update).toHaveBeenCalledWith({ instagramDeleteSenders: ["Bob"] });
  });

  it("lists the targeted senders", async () => {
    const { run, reply } = setup("list", true, { instagramDeleteSenders: ["Bob", "34600111222"] });
    await run();
    expect(text(reply)).toMatch(/Bob/);
    expect(text(reply)).toMatch(/34600111222/);
  });

  it("reports everyone when the list is empty", async () => {
    const { run, reply } = setup("list", true);
    await run();
    expect(text(reply)).toMatch(/everyone/i);
  });

  it("clears the list", async () => {
    const { run, update } = setup("clear", true, { instagramDeleteSenders: ["Bob"] });
    await run();
    expect(update).toHaveBeenCalledWith({ instagramDeleteSenders: [] });
  });
});
