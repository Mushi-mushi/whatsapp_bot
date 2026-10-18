import { afterEach, describe, expect, it, vi } from "vitest";
import pino from "pino";
import { DEFAULT_CONFIG } from "../src/config/schema.js";
import { ServiceDiagnostics } from "../src/util/service-status.js";

const logger = pino({ level: "silent" });
const config = { ...DEFAULT_CONFIG, askEnabled: true, paintEnabled: true };
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers(); });
function setup() {
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async (url) => {
    const path = new URL(String(url)).pathname;
    return Response.json(path === "/api/tags" ? { models: [] } : path === "/system_stats"
      ? { system: { comfyui_version: "test" } } : { status: "ok" });
  });
  vi.stubGlobal("fetch", fetcher);
  return { fetcher, diagnostics: new ServiceDiagnostics(logger) };
}

describe("service diagnostics", () => {
  it("uses only lightweight GET endpoints with bounded signals and no inference or private output", async () => {
    const { fetcher, diagnostics } = setup();
    const result = await diagnostics.check(config);
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(fetcher.mock.calls.map(([url]) => new URL(String(url)).pathname)).toEqual(["/api/tags", "/system_stats", "/health"]);
    for (const [, options] of fetcher.mock.calls) {
      expect(options).toEqual({ signal: expect.any(AbortSignal), redirect: "error" });
    }
    expect(result.services.map((s) => s.status)).toEqual(["available", "available", "available"]);
    expect(result.services.every((s) => s.latencyMs !== null && s.latencyMs >= 0)).toBe(true);
    expect(JSON.stringify(result)).not.toContain("http://");
  });

  it("does not contact disabled or unsupported services", async () => {
    const { fetcher, diagnostics } = setup();
    const result = await diagnostics.check({ ...config, askEnabled: false, paintEnabled: false, audioDownloadEnabled: false });
    expect(result.services.map((s) => s.status)).toEqual(["disabled", "disabled", "disabled"]);
    expect(result.services.every((s) => s.latencyMs === null)).toBe(true);
    expect(fetcher).not.toHaveBeenCalled();
    const unsupported = await diagnostics.check({ ...config, askEnabled: false, paintEnabled: false, transcriptionProvider: "other" });
    expect(unsupported.services[2].status).toBe("unsupported");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("coalesces simultaneous checks, caches results for 30 seconds and returns defensive copies", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(1000);
    const { fetcher, diagnostics } = setup();
    const [first, second] = await Promise.all([diagnostics.check(config), diagnostics.check(config)]);
    expect(fetcher).toHaveBeenCalledTimes(3);
    first.services[0].status = "timeout";
    expect(second.services[0].status).toBe("available");
    vi.setSystemTime(30999);
    expect((await diagnostics.check(config)).services[0].status).toBe("available");
    expect(fetcher).toHaveBeenCalledTimes(3);
    vi.setSystemTime(31000);
    await diagnostics.check(config);
    expect(fetcher).toHaveBeenCalledTimes(6);
  });

  it("invalidates cached checks when saved service settings change", async () => {
    const { fetcher, diagnostics } = setup();
    await diagnostics.check(config);
    await diagnostics.check({ ...config, ollamaBaseUrl: "http://changed:11434" });
    expect(fetcher).toHaveBeenCalledTimes(6);
    expect(String(fetcher.mock.calls[3][0])).toContain("changed");
  });

  it.each([
    ["http-error", () => Promise.resolve(new Response("PRIVATE error", { status: 503 }))],
    ["unreachable", () => Promise.reject(new TypeError("PRIVATE hostname"))],
    ["invalid-response", () => Promise.resolve(Response.json({ secret: "PRIVATE" }))],
    ["invalid-response", () => Promise.resolve(new Response("not JSON"))],
  ] as const)("distinguishes %s without exposing remote errors", async (status, response) => {
    const { fetcher, diagnostics } = setup();
    fetcher.mockImplementation(response);
    const result = await diagnostics.check(config);
    expect(result.services.every((s) => s.status === status)).toBe(true);
    expect(JSON.stringify(result)).not.toContain("PRIVATE");
  });

  it("reports three-second timeouts without waiting for inference timeouts", async () => {
    const { fetcher, diagnostics } = setup();
    fetcher.mockImplementation((_url, options) => new Promise((_resolve, reject) => {
      options?.signal?.addEventListener("abort", () => reject(options.signal?.reason), { once: true });
    }));
    const started = Date.now();
    const result = await diagnostics.check(config);
    expect(result.services.every((s) => s.status === "timeout")).toBe(true);
    expect(Date.now() - started).toBeLessThan(4500);
  });

  it.each(["not a URL", "file:///private", "http://user:password@localhost"])("rejects invalid/credentialed URL %s without fetching it", async (url) => {
    const { fetcher, diagnostics } = setup();
    const result = await diagnostics.check({ ...config, ollamaBaseUrl: url, paintEnabled: false, transcriptionEnabled: false });
    expect(result.services[0].status).toBe("invalid-config");
    expect(fetcher).not.toHaveBeenCalled();
  });
});
