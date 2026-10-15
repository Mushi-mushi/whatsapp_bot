import { describe, it, expect, vi } from "vitest";
import { makeServices } from "../src/handlers/commands/services.js";
import { Context, type Services } from "../src/router/context.js";
import { DEFAULT_CONFIG, type BotConfig } from "../src/config/schema.js";
import type { ConfigController } from "../src/config/controller.js";
import type { IncomingMessage } from "../src/transport/types.js";
import type { WAMessage } from "@whiskeysockets/baileys";

function setup(args: string, fromMe: boolean, initial: Partial<BotConfig> = {}) {
  let config: BotConfig = { ...DEFAULT_CONFIG, ...initial };
  const update = vi.fn((patch: Partial<BotConfig>) => {
    config = { ...config, ...patch };
    return config;
  });
  const settings: ConfigController = { get: () => config, update };
  const msg: IncomingMessage = {
    chatId: "c@s.whatsapp.net",
    chatName: "Chat",
    senderId: "owner@s.whatsapp.net",
    senderName: "Owner",
    senderPhone: "123",
    messageId: "m1",
    fromMe,
    isGroup: false,
    text: `bot.services ${args}`,
    kind: "text",
    timestamp: Date.now(),
    raw: {} as WAMessage,
  };
  const sendText = vi.fn(async () => {});
  const services: Services = {
    transport: { sendText } as unknown as Services["transport"],
    getConfig: () => config,
  };
  const ctx = new Context(msg, services);
  ctx.args = args;
  return { run: () => makeServices(settings)(ctx), sendText, update, config: () => config };
}

const replyText = (sendText: ReturnType<typeof vi.fn>) => sendText.mock.calls[0][1] as string;

describe("bot.services", () => {
  it("disables both services with no service argument", async () => {
    const { run, update, config } = setup("off", true, { askEnabled: true, paintEnabled: true });
    await run();
    expect(update).toHaveBeenCalledWith({ askEnabled: false, paintEnabled: false });
    expect(config().askEnabled).toBe(false);
    expect(config().paintEnabled).toBe(false);
  });

  it("can disable one service without changing the other", async () => {
    const { run, update, config } = setup("off ollama", true, { askEnabled: true, paintEnabled: true });
    await run();
    expect(update).toHaveBeenCalledWith({ askEnabled: false });
    expect(config().paintEnabled).toBe(true);
  });

  it("can re-enable both services", async () => {
    const { run, update, config } = setup("on all", true, { askEnabled: false, paintEnabled: false });
    await run();
    expect(update).toHaveBeenCalledWith({ askEnabled: true, paintEnabled: true });
    expect(config().askEnabled).toBe(true);
    expect(config().paintEnabled).toBe(true);
  });

  it("reports service status without changing configuration", async () => {
    const { run, update, sendText } = setup("status", true, { askEnabled: false, paintEnabled: true });
    await run();
    expect(update).not.toHaveBeenCalled();
    expect(replyText(sendText)).toContain("Ollama (AI commands): *OFF*");
    expect(replyText(sendText)).toContain("ComfyUI (image/video generation): *ON*");
  });

  it("refuses non-owner callers", async () => {
    const { run, update, sendText } = setup("off", false);
    await run();
    expect(update).not.toHaveBeenCalled();
    expect(replyText(sendText)).toMatch(/only the bot owner/i);
  });

  it("rejects unknown arguments", async () => {
    const { run, update, sendText } = setup("maybe", true);
    await run();
    expect(update).not.toHaveBeenCalled();
    expect(replyText(sendText)).toContain("bot.services");
  });
});
