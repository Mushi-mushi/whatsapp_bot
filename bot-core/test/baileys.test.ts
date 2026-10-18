import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import pino from "pino";
import { BaileysTransport } from "../src/transport/baileys.js";

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
    user: { id: "123456789:1@s.whatsapp.net" },
    onWhatsApp: vi.fn(async () => [{ exists: true }]),
    groupFetchAllParticipating: vi.fn(async () => ({})),
    end: vi.fn(() => ev.emit("connection.update", { connection: "close" })),
  };
  return socket;
}

const transports: BaileysTransport[] = [];

async function setup() {
  const socket = makeSocket();
  const replacement = makeSocket();
  mocks.makeSocket.mockReturnValueOnce(socket).mockReturnValue(replacement);
  const transport = new BaileysTransport({ authDir: "test-auth", logger: pino({ level: "silent" }) });
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
