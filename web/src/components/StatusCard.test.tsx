import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "@/lib/api";
import { StatusCard } from "./StatusCard";

vi.mock("@/lib/api", async (original) => {
  const actual = await original<typeof import("@/lib/api")>();
  return {
    ...actual,
    api: {
      ...actual.api,
      getSiesta: vi.fn(),
      cancelSiesta: vi.fn(),
    },
  };
});

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

describe("StatusCard siesta control", () => {
  it("shows the cancel command during siesta and refreshes after cancelling", async () => {
    vi.mocked(api.getSiesta)
      .mockResolvedValueOnce({ sleeping: true, until: Date.now() + 60_000 })
      .mockResolvedValue({ sleeping: false, until: null });
    vi.mocked(api.cancelSiesta).mockResolvedValue({ ok: true, cancelled: true });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <StatusCard status={{
          state: "open", health: "online", qrDataUrl: null, pairingCode: null, me: null, lastActivityAt: null,
        }} />
      </QueryClientProvider>,
    );

    fireEvent.click(await screen.findByRole("button", { name: "Cancel siesta" }));

    await waitFor(() => expect(api.cancelSiesta).toHaveBeenCalledOnce());
    await waitFor(() => expect(screen.queryByRole("button", { name: "Cancel siesta" })).toBeNull());
    expect(screen.getByText("Siesta cancelled. Root override announcement queued.")).toBeTruthy();
    client.clear();
  });
});
