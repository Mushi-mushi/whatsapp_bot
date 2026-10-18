import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, ApiError, type FailedDeliveriesResponse } from "@/lib/api";
import { FailedDeliveries } from "./FailedDeliveries";

const sample: FailedDeliveriesResponse = {
  deliveries: [
    { id: 1, attempts: 5, retryCount: 2, failedAt: 1000, failureKind: "timeout" },
    { id: 2, attempts: 5, retryCount: 0, failedAt: null, failureKind: "unknown" },
  ], total: 2, page: 1, pageSize: 50, sampledAt: 3000,
};
const empty = { ...sample, deliveries: [], total: 0 };
const clients: QueryClient[] = [];
beforeEach(() => {
  vi.spyOn(api, "getFailedDeliveries").mockResolvedValue(sample);
  vi.spyOn(api, "retryDelivery").mockResolvedValue({ ok: true, retriedId: 1 });
  vi.spyOn(api, "getDeliveryHistory").mockResolvedValue({ id: 1, total: 0, attempts: [] });
  vi.spyOn(window, "confirm").mockReturnValue(true);
});
afterEach(() => {
  cleanup();
  clients.splice(0).forEach((client) => client.clear());
  vi.restoreAllMocks();
  vi.useRealTimers();
});
function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  clients.push(client);
  const view = render(<QueryClientProvider client={client}><FailedDeliveries /></QueryClientProvider>);
  return { client, view };
}
const retryButton = (id: number) => screen.getByRole("button", { name: `Retry delivery ${id} once` });

describe("failed-delivery recovery", () => {
  it("distinguishes loading, errors, retry and an honest empty list", async () => {
    vi.mocked(api.getFailedDeliveries).mockReturnValueOnce(new Promise(() => {}));
    mount();
    expect(screen.getByRole("status").textContent).toContain("Loading failed deliveries");
    expect(screen.queryByText("No exhausted deliveries to retry.")).toBeNull();
    cleanup();
    vi.mocked(api.getFailedDeliveries).mockRejectedValue(new Error("offline"));
    mount();
    expect((await screen.findByRole("alert")).textContent).toContain("offline");
    vi.mocked(api.getFailedDeliveries).mockResolvedValue(empty);
    fireEvent.click(screen.getByRole("button", { name: "Retry failed deliveries list" }));
    expect(await screen.findByText("No exhausted deliveries to retry.")).toBeTruthy();
  });

  it("shows sanitized failure categories, unknown legacy dates and manual retry counts", async () => {
    mount();
    await screen.findByText("Failed delivery #1");
    expect(screen.getByText(/Send timed out; delivery may have completed/)).toBeTruthy();
    expect(screen.getByText("No failure category recorded.")).toBeTruthy();
    expect(screen.getByText(/Unknown \(before monitoring\)/)).toBeTruthy();
    expect(screen.getByText(/Manual retries scheduled: 2/)).toBeTruthy();
    expect(api.getDeliveryHistory).not.toHaveBeenCalled();
  });

  it("warns of duplicate risk and does not mutate if confirmation is declined", async () => {
    vi.mocked(window.confirm).mockReturnValue(false);
    mount();
    await screen.findByText("Failed delivery #1");
    fireEvent.click(retryButton(1));
    expect(window.confirm).toHaveBeenCalledWith(expect.stringContaining("duplicate message"));
    expect(api.retryDelivery).not.toHaveBeenCalled();
  });

  it("sends an explicit version/risk acknowledgement, removes only successful retries and invalidates Operations", async () => {
    const { client } = mount();
    const invalidate = vi.spyOn(client, "invalidateQueries");
    await screen.findByText("Failed delivery #1");
    vi.mocked(api.getFailedDeliveries).mockResolvedValue({ ...sample, total: 1, deliveries: [sample.deliveries[1]] });
    fireEvent.click(retryButton(1));
    expect(await screen.findByText(/One additional attempt scheduled for delivery #1/)).toBeTruthy();
    expect(api.retryDelivery).toHaveBeenCalledWith(1, { expectedRetryCount: 2, acknowledgeDuplicateRisk: true });
    await waitFor(() => expect(screen.queryByText("Failed delivery #1")).toBeNull());
    expect(screen.getByText("Failed delivery #2")).toBeTruthy();
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["operations"] });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["delivery-history"] });
    expect(screen.getByRole("status").textContent).toContain("does not confirm delivery");
  });

  it("disables all retry actions while scheduling is pending", async () => {
    vi.mocked(api.retryDelivery).mockReturnValue(new Promise(() => {}));
    mount();
    await screen.findByText("Failed delivery #1");
    fireEvent.click(retryButton(1));
    await waitFor(() => expect((retryButton(2) as HTMLButtonElement).disabled).toBe(true));
    expect(retryButton(1).textContent).toBe("Scheduling retry...");
    expect((screen.getByRole("button", { name: "Refresh failed deliveries" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("reports a stale/concurrent retry conflict without false success", async () => {
    vi.mocked(api.retryDelivery).mockRejectedValue(new ApiError(409, "Delivery changed; no retry was scheduled."));
    mount();
    await screen.findByText("Failed delivery #1");
    vi.mocked(api.getFailedDeliveries).mockResolvedValue(empty);
    fireEvent.click(retryButton(1));
    expect((await screen.findByRole("alert")).textContent).toContain("no retry was scheduled");
    expect(await screen.findByText("No exhausted deliveries to retry.")).toBeTruthy();
    expect(screen.queryByText(/One additional attempt scheduled/)).toBeNull();
  });

  it("retains a failed row with explicit error if retrying fails", async () => {
    vi.mocked(api.retryDelivery).mockRejectedValue(new Error("server unavailable"));
    mount();
    await screen.findByText("Failed delivery #1");
    fireEvent.click(retryButton(1));
    expect((await screen.findByRole("alert")).textContent).toContain("server unavailable");
    expect(screen.getByText("Failed delivery #1")).toBeTruthy();
    expect(screen.queryByText(/One additional attempt scheduled/)).toBeNull();
  });

  it("marks stale data and prevents retry on a failed background refresh", async () => {
    mount();
    await screen.findByText("Failed delivery #1");
    vi.mocked(api.getFailedDeliveries).mockRejectedValue(new Error("refresh failed"));
    fireEvent.click(screen.getByRole("button", { name: "Refresh failed deliveries" }));
    await screen.findByRole("alert");
    expect(screen.getByText(/Last successful failed-delivery snapshot \(may be stale\)/)).toBeTruthy();
    expect((retryButton(1) as HTMLButtonElement).disabled).toBe(true);
  });

  it("does not resurrect a scheduled retry if the subsequent refresh fails", async () => {
    mount();
    await screen.findByText("Failed delivery #1");
    vi.mocked(api.getFailedDeliveries).mockRejectedValue(new Error("refresh failed"));
    fireEvent.click(retryButton(1));
    await screen.findByRole("alert");
    expect(screen.queryByText("Failed delivery #1")).toBeNull();
    expect(await screen.findByText(/One additional attempt scheduled/)).toBeTruthy();
    expect((retryButton(2) as HTMLButtonElement).disabled).toBe(true);
  });

  it("can go back after a later-page error", async () => {
    vi.mocked(api.getFailedDeliveries).mockImplementation(async (page) => {
      if (page === 2) throw new Error("page unavailable");
      return { ...sample, total: 51 };
    });
    mount();
    await screen.findByText("Failed delivery #1");
    fireEvent.click(screen.getByRole("button", { name: "Next failed deliveries" }));
    await screen.findByRole("alert");
    fireEvent.click(screen.getByRole("button", { name: "Previous failed deliveries" }));
    expect(await screen.findByText("Failed delivery #1")).toBeTruthy();
  });

  it("loads history only on inspection and explains missing legacy history", async () => {
    mount();
    await screen.findByText("Failed delivery #1");
    fireEvent.click(screen.getByRole("button", { name: "Inspect delivery 1" }));
    expect(await screen.findByText(/No recorded attempts; older attempts were not captured/)).toBeTruthy();
    expect(api.getDeliveryHistory).toHaveBeenCalledWith(1);
    expect(screen.getByText(/Latest 50 recorded claims/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Close delivery history" }));
    expect(screen.queryByRole("region", { name: "Delivery 1 history" })).toBeNull();
  });

  it("shows history failures with retry then sanitized outcomes and manual rounds", async () => {
    vi.mocked(api.getDeliveryHistory).mockRejectedValue(new ApiError(404, "Delivery not found; it may have been pruned."));
    mount();
    await screen.findByText("Failed delivery #1");
    fireEvent.click(screen.getByRole("button", { name: "Inspect delivery 1" }));
    expect((await screen.findByRole("alert")).textContent).toContain("may have been pruned");
    vi.mocked(api.getDeliveryHistory).mockResolvedValue({ id: 1, total: 1, attempts: [
      { id: 6, retryCount: 2, startedAt: 1000, finishedAt: 2000, outcome: "lease-expired", failureKind: "lease-expired" },
    ] });
    fireEvent.click(screen.getByRole("button", { name: "Retry delivery history" }));
    expect(await screen.findByText(/Round 2 · lease-expired/)).toBeTruthy();
    expect(screen.getByText(/Worker lease expired; delivery outcome is uncertain/)).toBeTruthy();
  });

  it("polls while open and stops after unmount", async () => {
    vi.useFakeTimers();
    const { view } = mount();
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    await act(async () => { await vi.advanceTimersByTimeAsync(10001); });
    expect(api.getFailedDeliveries).toHaveBeenCalledTimes(2);
    view.unmount();
    await act(async () => { await vi.advanceTimersByTimeAsync(20000); });
    expect(api.getFailedDeliveries).toHaveBeenCalledTimes(2);
  });
});
