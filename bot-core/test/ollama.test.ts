import { afterEach, describe, expect, it, vi } from "vitest";
import { ollamaChat } from "../src/util/ollama.js";
import { DEFAULT_CONFIG } from "../src/config/schema.js";
import { createServer } from "node:http";

afterEach(() => { vi.unstubAllGlobals(); });

describe("Ollama cancellation", () => {
  it("closes an in-flight streaming connection when cancelled", async () => {
    let received!: () => void;
    let closed!: () => void;
    const requestReceived = new Promise<void>((resolve) => { received = resolve; });
    const connectionClosed = new Promise<void>((resolve) => { closed = resolve; });
    const server = createServer((req, res) => {
      req.resume();
      res.on("close", closed);
      res.writeHead(200, { "Content-Type": "application/x-ndjson" });
      res.write('{"message":{"content":"Working"}}\n');
      received();
    });
    await new Promise<void>((resolve) => { server.listen(0, "127.0.0.1", resolve); });
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Missing test server port");
      const controller = new AbortController();
      const pending = ollamaChat({
        ...DEFAULT_CONFIG, ollamaBaseUrl: `http://127.0.0.1:${address.port}`,
      }, [], { signal: controller.signal });
      const rejected = expect(pending).rejects.toThrow("Cancelled stream");
      await requestReceived;
      controller.abort(new Error("Cancelled stream"));
      await rejected;
      await connectionClosed;
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        server.close((err) => { if (err) reject(err); else resolve(); });
      });
    }
  });

  it("aborts the actual fetch and propagates cancellation rather than reporting unreachable", async () => {
    let requestSignal!: AbortSignal;
    vi.stubGlobal("fetch", vi.fn((_url: string, init: RequestInit) => {
      requestSignal = init.signal!;
      return new Promise((_resolve, reject) => {
        requestSignal.addEventListener("abort", () => reject(requestSignal.reason), { once: true });
      });
    }));
    const controller = new AbortController();
    const pending = ollamaChat(DEFAULT_CONFIG, [], { signal: controller.signal });
    const rejected = expect(pending).rejects.toThrow("Cancelled");
    controller.abort(new Error("Cancelled"));
    await rejected;
    expect(requestSignal.aborted).toBe(true);
  });

  it("keeps existing successful streaming behavior and sends the configured retention", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(
      '{"message":{"content":"Hello"}}\n{"done":true}\n',
    ));
    vi.stubGlobal("fetch", fetch);
    expect(await ollamaChat({ ...DEFAULT_CONFIG, ollamaKeepAlive: "0" }, [])).toEqual({ ok: true, content: "Hello" });
    expect(JSON.parse(fetch.mock.calls[0][1].body).keep_alive).toBe("0");
  });
});
