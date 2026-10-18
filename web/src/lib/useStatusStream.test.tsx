import { act, cleanup, renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, ApiError, clearToken, setToken, type Status } from "./api";
import { useStatusStream } from "./useStatusStream";

const status: Status = {
  state: "open", health: "online", qrDataUrl: null, pairingCode: null, me: "owner",
  lastActivityAt: 123,
};
const clients: QueryClient[] = [];

function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  clients.push(client);
  const invalidated = vi.spyOn(client, "invalidateQueries");
  return {
    ...renderHook(() => useStatusStream(), {
      wrapper: ({ children }: { children: ReactNode }) =>
        <QueryClientProvider client={client}>{children}</QueryClientProvider>,
    }),
    invalidated,
  };
}

async function settle() {
  await act(async () => {
    for (let i = 0; i < 15; i++) await Promise.resolve();
  });
}

function stream(signal?: AbortSignal | null) {
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(status)}\n\n`));
      signal?.addEventListener("abort", () => controller.error(new DOMException("Aborted", "AbortError")), { once: true });
    },
  }));
}

beforeEach(() => {
  vi.useFakeTimers();
  clearToken();
});
afterEach(() => {
  cleanup();
  for (const client of clients.splice(0)) client.clear();
  clearToken();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("status stream recovery", () => {
  it("reconnects after entering a token without remounting the app", async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 401 }))
      .mockImplementationOnce(async (_input, init) => stream(init?.signal));
    vi.stubGlobal("fetch", fetcher);
    const { result, invalidated } = mount();
    await settle();
    expect(result.current).toBeNull();
    expect(invalidated).toHaveBeenCalledWith({ queryKey: ["config"] });
    act(() => setToken("new-token"));
    await settle();
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(new Headers(fetcher.mock.calls[1][1]?.headers).get("Authorization")).toBe("Bearer new-token");
    expect(result.current).toEqual(status);
  });

  it("aborts the previous stream when the token changes", async () => {
    setToken("first");
    const signals: AbortSignal[] = [];
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(async (_input, init) => {
      signals.push(init!.signal!);
      return stream(init?.signal);
    }));
    const { result } = mount();
    await settle();
    act(() => setToken("second"));
    await settle();
    expect(signals[0].aborted).toBe(true);
    expect(signals[1].aborted).toBe(false);
    expect(result.current).toEqual(status);
  });

  it("uses a status snapshot when streaming fails and retries streaming", async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockRejectedValueOnce(new Error("stream offline"))
      .mockImplementationOnce(async (_input, init) => stream(init?.signal));
    vi.stubGlobal("fetch", fetcher);
    const snapshot = vi.spyOn(api, "getStatus").mockResolvedValue(status);
    const { result } = mount();
    await settle();
    expect(snapshot).toHaveBeenCalledOnce();
    expect(result.current).toEqual(status);
    await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(result.current).toEqual(status);
  });

  it("invalidates authentication on an unauthorized fallback and stops retrying", async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValue(new Error("stream offline"));
    vi.stubGlobal("fetch", fetcher);
    vi.spyOn(api, "getStatus").mockRejectedValue(new ApiError(401, "unauthorized"));
    const { result, invalidated } = mount();
    await settle();
    expect(result.current).toBeNull();
    expect(invalidated).toHaveBeenCalledWith({ queryKey: ["config"] });
    await act(async () => { await vi.advanceTimersByTimeAsync(6000); });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("cancels retries on unmount", async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValue(new Error("offline"));
    vi.stubGlobal("fetch", fetcher);
    vi.spyOn(api, "getStatus").mockRejectedValue(new Error("offline"));
    const { unmount } = mount();
    await settle();
    unmount();
    await act(async () => { await vi.advanceTimersByTimeAsync(6000); });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("ignores a late unauthorized response from the previous token", async () => {
    let release!: (response: Response) => void;
    const fetcher = vi.fn<typeof fetch>()
      .mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }))
      .mockImplementationOnce(async (_input, init) => stream(init?.signal));
    vi.stubGlobal("fetch", fetcher);
    const { result, invalidated } = mount();
    await settle();
    act(() => setToken("valid"));
    await settle();
    expect(result.current).toEqual(status);
    release(new Response(null, { status: 401 }));
    await settle();
    expect(result.current).toEqual(status);
    expect(invalidated).not.toHaveBeenCalled();
  });
});
