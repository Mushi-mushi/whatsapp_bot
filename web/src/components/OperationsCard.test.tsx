import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "@/lib/api";
import { operations } from "@/test/fixtures";
import { OperationsCard } from "./OperationsCard";

const clients: QueryClient[] = [];
beforeEach(() => { vi.spyOn(api, "getOperations").mockResolvedValue(operations); });
afterEach(() => {
  cleanup();
  for (const client of clients.splice(0)) client.clear();
  vi.restoreAllMocks();
  vi.useRealTimers();
});
function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  clients.push(client);
  render(<QueryClientProvider client={client}><OperationsCard /></QueryClientProvider>);
  return client;
}
function metric(label: string): string | null {
  return screen.getByText(label).parentElement?.querySelector("dd")?.textContent ?? null;
}

describe("operations overview", () => {
  it("shows loading without claiming the queues have no failures", () => {
    vi.mocked(api.getOperations).mockReturnValue(new Promise(() => {}));
    mount();
    expect(screen.getByRole("status").textContent).toContain("Loading operations");
    expect(screen.queryByText("No unresolved delivery failures.")).toBeNull();
    expect((screen.getByRole("button", { name: "Refresh operations" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("shows query errors with retry, then distinguishes successful empty results", async () => {
    vi.mocked(api.getOperations).mockRejectedValue(new Error("monitor offline"));
    mount();
    expect((await screen.findByRole("alert")).textContent).toContain("monitor offline");
    expect(screen.queryByText("No unresolved delivery failures.")).toBeNull();
    vi.mocked(api.getOperations).mockResolvedValue(operations);
    fireEvent.click(screen.getByRole("button", { name: "Retry operations" }));
    expect(await screen.findByText("No unresolved delivery failures.")).toBeTruthy();
    expect(screen.getByText("No background execution failures recorded this process.")).toBeTruthy();
    expect(metric("Running jobs")).toBe("0");
    expect(metric("Failed deliveries")).toBe("0");
  });

  it("renders activity, capacity, retries and failure metadata with no mutation controls", async () => {
    vi.mocked(api.getOperations).mockResolvedValue({
      ...operations, deliveryReady: false,
      jobs: {
        ...operations.jobs, accepting: false, running: { kind: "profile", startedAt: operations.sampledAt - 65000 },
        queued: 2, completed: 3, failed: 1, oldestQueuedAt: operations.sampledAt - 10000,
        rejected: { capacity: 4, duplicate: 5, stopping: 6 },
        recentFailures: [{ id: 1, kind: "command", startedAt: 1000, failedAt: 3000 }],
      },
      outbox: {
        counts: { pending: 2, sending: 1, failed: 1, sent: 10, cancelled: 3 },
        ready: 1, retrying: 2, expiredLeases: 1, nextAttemptAt: 5000,
        recentFailures: [
          { id: 7, status: "pending", attempts: 2, failedAt: 1000, retryAt: 5000 },
          { id: 8, status: "failed", attempts: 5, failedAt: null, retryAt: null },
          { id: 9, status: "sending", attempts: 3, failedAt: 2000, retryAt: 300000 },
        ],
      },
    });
    mount();
    await screen.findByRole("heading", { name: "Background jobs" });
    expect(metric("Running jobs")).toBe("1");
    expect(metric("Queued jobs")).toBe("2");
    expect(metric("Failed jobs")).toBe("1");
    expect(metric("Retrying deliveries")).toBe("2");
    expect(metric("Expired leases")).toBe("1");
    expect(screen.getByText(/Draining for shutdown/)).toBeTruthy();
    expect(screen.getByText(/Running profile refresh/).textContent).toContain("0h 1m 5s");
    expect(screen.getByText(/Delivery transport disconnected/)).toBeTruthy();
    expect(screen.getByText(/Command failed at/)).toBeTruthy();
    expect(screen.getByText(/Delivery #7/).textContent).toContain("2/5 attempts");
    expect(screen.getByText(/Unknown \(before monitoring/)).toBeTruthy();
    expect(screen.getByText(/No automatic retry remaining/)).toBeTruthy();
    expect(screen.getByText(/Lease expires at/)).toBeTruthy();
    expect(screen.getByText(/Retry eligible at/)).toBeTruthy();
    expect(screen.getAllByRole("button").map((button) => button.textContent?.trim())).toEqual(["Refresh operations"]);
  });

  it("keeps cached data explicitly marked stale after a refresh fails", async () => {
    mount();
    await screen.findByText("No unresolved delivery failures.");
    vi.mocked(api.getOperations).mockRejectedValue(new Error("refresh failed"));
    fireEvent.click(screen.getByRole("button", { name: "Refresh operations" }));
    expect((await screen.findByRole("alert")).textContent).toContain("refresh failed");
    expect(screen.getByText(/Last successful snapshot \(may be stale\)/)).toBeTruthy();
    expect(metric("Pending deliveries")).toBe("0");
  });

  it("polls while mounted and stops polling when the section closes", async () => {
    vi.useFakeTimers();
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    clients.push(client);
    const view = render(<QueryClientProvider client={client}><OperationsCard /></QueryClientProvider>);
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(api.getOperations).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(api.getOperations).toHaveBeenCalledTimes(2);
    view.unmount();
    await act(async () => { await vi.advanceTimersByTimeAsync(10000); });
    expect(api.getOperations).toHaveBeenCalledTimes(2);
  });
});
