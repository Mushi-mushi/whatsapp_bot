import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import pino from "pino";
import { BaileysTransport, type BaileysOptions } from "../src/transport/baileys.js";
import type { GroupParticipant, WAMessage } from "@whiskeysockets/baileys";
import type { IncomingMessage } from "../src/transport/types.js";
import { approvedSenderGuard } from "../src/middleware/index.js";
import { Context } from "../src/router/context.js";
import { DEFAULT_CONFIG } from "../src/config/schema.js";
import { senderKey } from "../src/handlers/commands/user-context.js";
import { openDatabase } from "../src/state/db.js";
import { ContactsStore } from "../src/state/repos.js";

const mocks = vi.hoisted(() => ({
  makeSocket: vi.fn(),
  loadAuth: vi.fn(),
  version: vi.fn(),
  clearAuth: vi.fn(),
}));

vi.mock("@whiskeysockets/baileys", () => ({
  default: mocks.makeSocket,
  useMultiFileAuthState: mocks.loadAuth,
  fetchLatestBaileysVersion: mocks.version,
  DisconnectReason: { loggedOut: 401 },
}));
vi.mock("node:fs/promises", () => ({ rm: mocks.clearAuth }));

function makeSocket() {
  const ev = new EventEmitter();
  const socket = {
    ev: Object.assign(ev, { isBuffering: vi.fn(() => false) }),
    user: { id: "123456789:1@s.whatsapp.net", name: "Owner" },
    onWhatsApp: vi.fn(async () => [{ exists: true }]),
    groupFetchAllParticipating: vi.fn(async () => ({})),
    groupMetadata: vi.fn(async (): Promise<{ participants: GroupParticipant[]; subject: string }> =>
      ({ participants: [], subject: "Group" })),
    sendMessage: vi.fn(async () => undefined),
    end: vi.fn(() => ev.emit("connection.update", { connection: "close" })),
  };
  return socket;
}

const transports: BaileysTransport[] = [];

async function setup(options: Partial<BaileysOptions> = {}) {
  const socket = makeSocket();
  const replacement = makeSocket();
  mocks.makeSocket.mockReturnValueOnce(socket).mockReturnValue(replacement);
  const transport = new BaileysTransport({ authDir: "test-auth", logger: pino({ level: "silent" }), ...options });
  transports.push(transport);
  await transport.start();
  socket.ev.emit("connection.update", { connection: "open" });
  return { transport, socket, replacement };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.resetAllMocks();
  mocks.loadAuth.mockResolvedValue({ state: { creds: { registered: true } }, saveCreds: vi.fn() });
  mocks.version.mockResolvedValue({ version: [2, 3000, 1] });
});

function message(chatId: string, key: Partial<WAMessage["key"]> = {}): WAMessage {
  return {
    key: { remoteJid: chatId, fromMe: false, id: "synthetic", ...key },
    pushName: "Alex",
    message: { conversation: "synthetic message" },
    messageTimestamp: Math.floor(Date.now() / 1000),
  };
}

async function receive(
  transport: BaileysTransport, socket: ReturnType<typeof makeSocket>, raw: WAMessage,
): Promise<IncomingMessage | undefined> {
  const received: IncomingMessage[] = [];
  const unsubscribe = transport.onMessage((msg) => received.push(msg));
  socket.ev.emit("messages.upsert", { type: "notify", messages: [raw] });
  await vi.advanceTimersByTimeAsync(0);
  unsubscribe();
  return received[0];
}

describe("WhatsApp identity resolution", () => {
  it("learns nameless message aliases durably, resolves missing PN hints and keeps raw reply addresses", async () => {
    const db = openDatabase(":memory:");
    try {
      const contacts = new ContactsStore(db);
      const options = { loadContacts: () => contacts.all(), persistContacts: contacts.upsertMany.bind(contacts) };
      const { transport, socket } = await setup(options);
      const first = await receive(transport, socket, message("900@lid", { senderPn: "34600000001@s.whatsapp.net" }));
      const later = await receive(transport, socket, message("900@lid"));
      const pn = await receive(transport, socket, message("34600000001:2@s.whatsapp.net"));
      expect(first).toMatchObject({
        chatId: "900@lid", senderId: "900@lid",
        chatIdentity: "34600000001@s.whatsapp.net", senderIdentity: "34600000001@s.whatsapp.net",
        senderPhone: "34600000001",
      });
      expect(later?.senderPhone).toBe("34600000001");
      expect(senderKey(later!)).toBe(senderKey(first!));
      expect(senderKey(pn!)).toBe(senderKey(first!));
      const ctx = new Context(later!, { transport, getConfig: () => ({
        ...DEFAULT_CONFIG, approvedSenders: ["34600000001@s.whatsapp.net"],
      }) });
      const next = vi.fn();
      await approvedSenderGuard(ctx, next);
      expect(next).toHaveBeenCalledOnce();
      await ctx.reply("reply");
      expect(socket.sendMessage).toHaveBeenCalledWith("900@lid", { text: expect.any(String) });
      await ctx.quote("quoted reply");
      expect(socket.sendMessage).toHaveBeenCalledWith("900@lid", { text: expect.any(String) }, { quoted: later!.raw });
      await transport.stop();
      const restarted = await setup(options);
      const afterRestart = await receive(restarted.transport, restarted.socket, message("900@lid"));
      expect(afterRestart?.senderPhone).toBe("34600000001");
    } finally {
      db.close();
    }
  });

  it("keeps a LID approval working under PN addressing but never approves groups through a participant", async () => {
    const { transport, socket } = await setup({
      loadContacts: () => [{ jid: "900@lid", phone: "34600000001", name: "Alice" }],
    });
    const dm = await receive(transport, socket, message("34600000001@s.whatsapp.net"));
    const next = vi.fn();
    await approvedSenderGuard(new Context(dm!, { transport, getConfig: () => ({
      ...DEFAULT_CONFIG, approvedSenders: ["900@lid"],
    }) }), next);
    expect(next).toHaveBeenCalledOnce();
    next.mockClear();
    const group = await receive(transport, socket, message("group@g.us", { participant: "900@lid" }));
    await approvedSenderGuard(new Context(group!, { transport, getConfig: () => ({
      ...DEFAULT_CONFIG, approvedSenders: ["900@lid", "34600000001@s.whatsapp.net"],
    }) }), next);
    expect(next).not.toHaveBeenCalled();
    expect(senderKey(group!)).not.toBe(senderKey(dm!));
  });

  it("separates same-name unknown LIDs and rejects conflicting aliases with an explicit error", async () => {
    const logger = pino({ level: "silent" });
    const error = vi.spyOn(logger, "error");
    const persistContacts = vi.fn();
    const { transport, socket } = await setup({
      logger, persistContacts,
      loadContacts: () => [{ jid: "900@lid", phone: "34600000001", name: "Alex" }],
    });
    const first = await receive(transport, socket, message("901@lid"));
    const second = await receive(transport, socket, message("902@lid"));
    expect(first?.senderPhone).toBe("");
    expect(senderKey(first!)).not.toBe(senderKey(second!));
    expect(await receive(transport, socket, message("900@lid", { senderPn: "34600000002@s.whatsapp.net" })))
      .toBeUndefined();
    expect(error).toHaveBeenCalledWith({ err: expect.any(Error) }, "Failed to resolve incoming WhatsApp message");
    expect(persistContacts).not.toHaveBeenCalled();
    expect((await receive(transport, socket, message("900@lid")))?.senderPhone).toBe("34600000001");
  });

  it("does not accept an in-memory alias if persistence fails", async () => {
    const logger = pino({ level: "silent" });
    const error = vi.spyOn(logger, "error");
    const { transport, socket } = await setup({
      logger, persistContacts: () => { throw new Error("Disk unavailable"); },
    });
    expect(await receive(transport, socket, message("900@lid", { senderPn: "34600000001@s.whatsapp.net" })))
      .toBeUndefined();
    expect(error).toHaveBeenCalled();
    expect((await receive(transport, socket, message("900@lid")))?.senderPhone).toBe("");
  });

  it("preserves mappings through LID-only contact updates and names outgoing DMs after the recipient", async () => {
    const { transport, socket } = await setup();
    socket.ev.emit("contacts.upsert", [
      { id: "34600000001@s.whatsapp.net", lid: "900@lid", name: "Alice" },
      { id: "123456789@s.whatsapp.net", name: "Owner" },
    ]);
    socket.ev.emit("contacts.update", [{ id: "900@lid", notify: "Alicia" }]);
    const outgoing = await receive(transport, socket, message("900@lid", { fromMe: true }));
    expect(outgoing).toMatchObject({
      senderId: "123456789:1@s.whatsapp.net", senderPhone: "123456789",
      chatName: "Alice", senderName: "Owner", chatIdentity: "34600000001@s.whatsapp.net",
    });
    const unknown = await receive(transport, socket, message("999@lid", {
      fromMe: true, senderPn: "123456789@s.whatsapp.net", senderLid: "500@lid",
    }));
    expect(unknown?.chatName).toBe("999@lid");
    expect(unknown?.chatIdentity).toBe("999@lid");
    expect(unknown?.chatAliases).not.toContain("123456789@s.whatsapp.net");
    expect((await receive(transport, socket, message("900@lid")))?.senderPhone).toBe("34600000001");
    expect((await receive(transport, socket, message("999@lid")))?.senderPhone).toBe("");
  });

  it("learns LID hints on PN-addressed incoming messages without needing a contact name", async () => {
    const { transport, socket } = await setup();
    await receive(transport, socket, message("34600000001@s.whatsapp.net", { senderLid: "900@lid" }));
    expect((await receive(transport, socket, message("900@lid")))?.senderPhone).toBe("34600000001");
    await receive(transport, socket, message("group@g.us", {
      participant: "34600000002@s.whatsapp.net", participantLid: "901@lid",
    }));
    expect((await receive(transport, socket, message("group@g.us", { participant: "901@lid" })))?.senderPhone)
      .toBe("34600000002");
  });

  it("recognizes verified participant aliases without granting another participant admin rights", async () => {
    const { transport, socket } = await setup();
    socket.groupMetadata.mockResolvedValue({ subject: "Group", participants: [
      { id: "34600000001:2@s.whatsapp.net", lid: "900@lid", admin: "admin" },
      { id: "901@lid", jid: "34600000002@s.whatsapp.net", admin: null },
    ] });
    expect(await transport.isGroupAdmin("group@g.us", "900:3@lid")).toBe(true);
    expect(await transport.isGroupAdmin("group@g.us", "34600000002@s.whatsapp.net")).toBe(false);
    expect(await transport.isGroupAdmin("group@g.us", "999@lid")).toBe(false);
    socket.groupMetadata.mockResolvedValue({ subject: "Group", participants: [
      { id: "900@lid", jid: "34600000001@s.whatsapp.net", admin: null },
    ] });
    expect(await transport.isGroupAdmin("group@g.us", "34600000001@s.whatsapp.net")).toBe(false);
  });
});

afterEach(async () => {
  for (const transport of transports.splice(0)) await transport.stop();
  vi.useRealTimers();
});

describe("WhatsApp automatic recovery", () => {
  it("reconnects after two failed health checks without deleting credentials", async () => {
    const { socket, transport, replacement } = await setup();
    socket.onWhatsApp.mockRejectedValue(new Error("Timed Out"));
    await vi.advanceTimersByTimeAsync(120_000);
    expect(socket.end).toHaveBeenCalledOnce();
    expect(transport.getStatus()).toMatchObject({ state: "connecting", health: "stale" });
    await vi.advanceTimersByTimeAsync(2000);
    expect(mocks.makeSocket).toHaveBeenCalledTimes(2);
    expect(mocks.clearAuth).not.toHaveBeenCalled();
    replacement.ev.emit("connection.update", { connection: "open" });
    expect(transport.getStatus()).toMatchObject({ state: "open", health: "online" });
  });

  it("recovers persistently buffered events even when health queries succeed", async () => {
    const { socket } = await setup();
    socket.ev.isBuffering.mockReturnValue(true);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(socket.end).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(62_000);
    expect(socket.end).toHaveBeenCalledOnce();
    expect(mocks.makeSocket).toHaveBeenCalledTimes(2);
    expect(mocks.clearAuth).not.toHaveBeenCalled();
  });

  it("does not reconnect an idle healthy connection", async () => {
    const { socket } = await setup();
    await vi.advanceTimersByTimeAsync(600_000);
    expect(socket.end).not.toHaveBeenCalled();
    expect(mocks.makeSocket).toHaveBeenCalledOnce();
  });

  it("allows temporary buffering that clears before the next health check", async () => {
    const { socket } = await setup();
    socket.ev.isBuffering.mockReturnValue(true);
    await vi.advanceTimersByTimeAsync(60_000);
    socket.ev.isBuffering.mockReturnValue(false);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(socket.end).not.toHaveBeenCalled();
  });

  it("recovers probes that never settle, rather than overlapping them indefinitely", async () => {
    const { socket } = await setup();
    socket.onWhatsApp.mockImplementation(() => new Promise(() => {}));
    await vi.advanceTimersByTimeAsync(140_000);
    expect(socket.end).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(2000);
    expect(mocks.makeSocket).toHaveBeenCalledTimes(2);
  });

  it("recovers empty probe results after two failures", async () => {
    const { socket } = await setup();
    socket.onWhatsApp.mockResolvedValue([]);
    await vi.advanceTimersByTimeAsync(122_000);
    expect(socket.end).toHaveBeenCalledOnce();
    expect(mocks.makeSocket).toHaveBeenCalledTimes(2);
  });

  it("resets the failure count after a successful probe", async () => {
    const { socket } = await setup();
    socket.onWhatsApp.mockRejectedValueOnce(new Error("Timed Out"));
    await vi.advanceTimersByTimeAsync(120_000);
    socket.onWhatsApp.mockRejectedValueOnce(new Error("Timed Out"));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(socket.end).not.toHaveBeenCalled();
  });

  it("ignores a probe result from a socket that has been replaced", async () => {
    const { socket, replacement, transport } = await setup();
    let finishProbe: (result: { exists: boolean }[]) => void = () => {
      throw new Error("Probe did not start");
    };
    socket.onWhatsApp.mockImplementation(() => new Promise((resolve) => { finishProbe = resolve; }));
    await vi.advanceTimersByTimeAsync(60_000);
    socket.ev.emit("connection.update", { connection: "close" });
    await vi.advanceTimersByTimeAsync(2000);
    replacement.ev.emit("connection.update", { connection: "open" });
    const statusChanged = vi.fn();
    transport.onStatus(statusChanged);
    finishProbe([{ exists: true }]);
    await vi.advanceTimersByTimeAsync(0);
    expect(statusChanged).not.toHaveBeenCalled();
    expect(transport.getStatus()).toMatchObject({ state: "open", health: "online" });
  });

  it("cancels a pending recovery on shutdown", async () => {
    const { socket, transport } = await setup();
    socket.onWhatsApp.mockRejectedValue(new Error("Timed Out"));
    await vi.advanceTimersByTimeAsync(120_000);
    await transport.stop();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(mocks.makeSocket).toHaveBeenCalledOnce();
  });

  it("resets reconnect backoff when incoming messages resume", async () => {
    const { socket, replacement } = await setup();
    socket.ev.emit("connection.update", { connection: "close" });
    await vi.advanceTimersByTimeAsync(2000);
    replacement.ev.emit("connection.update", { connection: "open" });
    replacement.ev.emit("messages.upsert", { messages: [], type: "notify" });
    replacement.ev.emit("connection.update", { connection: "close" });
    await vi.advanceTimersByTimeAsync(2000);
    expect(mocks.makeSocket).toHaveBeenCalledTimes(3);
  });

  it("backs off failed reconnect attempts up to thirty seconds", async () => {
    const { socket } = await setup();
    mocks.loadAuth.mockRejectedValue(new Error("Auth temporarily unavailable"));
    socket.ev.emit("connection.update", { connection: "close" });
    let calls = 1;
    for (const delay of [2000, 4000, 8000, 16000, 30000, 30000]) {
      await vi.advanceTimersByTimeAsync(delay - 1);
      expect(mocks.loadAuth).toHaveBeenCalledTimes(calls);
      await vi.advanceTimersByTimeAsync(1);
      expect(mocks.loadAuth).toHaveBeenCalledTimes(++calls);
    }
    expect(mocks.clearAuth).not.toHaveBeenCalled();
  });
});
