import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, type AuditResponse } from "@/lib/api";
import { AuditTrail } from "./AuditTrail";

const sample: AuditResponse = {
  entries: [
    { id: 4, action: "pet.enable", targetId: `chat:${"a".repeat(64)}`, actor: "authenticated-api",
      startedAt: 1000, completedAt: 2000, outcome: "succeeded", statusCode: 200 },
    { id: 3, action: "delivery.retry", targetId: "12", actor: "authenticated-api",
      startedAt: 1000, completedAt: 2000, outcome: "rejected", statusCode: 409 },
    { id: 2, action: "config.save", targetId: null, actor: "authenticated-api",
      startedAt: 1000, completedAt: 2000, outcome: "failed", statusCode: 500 },
    { id: 1, action: "connection.relink", targetId: null, actor: "local-insecure-api",
      startedAt: 1000, completedAt: null, outcome: "unknown", statusCode: null },
  ], total: 4, page: 1, pageSize: 50, sampledAt: 3000, retentionDays: 90, maxEntries: 10000,
};
const empty = { ...sample, entries: [], total: 0 };
const clients: QueryClient[] = [];
beforeEach(() => { vi.spyOn(api, "getAudit").mockResolvedValue(sample); });
afterEach(() => {
  cleanup();
  clients.splice(0).forEach((client) => client.clear());
  vi.restoreAllMocks();
  vi.useRealTimers();
});
function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  clients.push(client);
  return render(<QueryClientProvider client={client}><AuditTrail /></QueryClientProvider>);
}

describe("administrative audit trail", () => {
  it("shows loading without falsely claiming no actions were recorded", () => {
    vi.mocked(api.getAudit).mockReturnValue(new Promise(() => {}));
    mount();
    expect(screen.getByRole("status").textContent).toContain("Loading audit trail");
    expect(screen.queryByText("No administrative actions recorded yet.")).toBeNull();
    expect((screen.getByRole("button", { name: "Refresh audit trail" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("distinguishes read failure, retry and an empty successful result", async () => {
    vi.mocked(api.getAudit).mockRejectedValue(new Error("offline"));
    mount();
    expect((await screen.findByRole("alert")).textContent).toContain("offline");
    expect(screen.queryByText("No administrative actions recorded yet.")).toBeNull();
    vi.mocked(api.getAudit).mockResolvedValue(empty);
    fireEvent.click(screen.getByRole("button", { name: "Retry audit trail" }));
    expect(await screen.findByText("No administrative actions recorded yet.")).toBeTruthy();
  });

  it("renders success/rejection/failure/unknown honestly, including opaque targets, actor limits and retention", async () => {
    mount();
    expect(await screen.findByRole("heading", { name: "#4 · Enable/spawn pet" })).toBeTruthy();
    expect(screen.getByText("Succeeded · HTTP 200")).toBeTruthy();
    expect(screen.getByText("Rejected · HTTP 409")).toBeTruthy();
    expect(screen.getByText("Failed; changes may have occurred · HTTP 500")).toBeTruthy();
    expect(screen.getByText("Outcome unknown; in progress or interrupted")).toBeTruthy();
    expect(screen.getByText(`Target: chat:${"a".repeat(64)}`).className).toContain("break-all");
    expect(screen.getByText("Target: 12")).toBeTruthy();
    expect(screen.getAllByText("Target: Not applicable or unavailable")).toHaveLength(2);
    expect(screen.getAllByText("Actor: Authenticated API (shared token)")).toHaveLength(3);
    expect(screen.getByText("Actor: Local insecure API (authentication disabled)")).toBeTruthy();
    expect(screen.getByText(/Retention: 90 days/).textContent).toContain((10000).toLocaleString());
    expect(screen.getByText(/Shared-token authentication cannot identify individual people/)).toBeTruthy();
    expect(screen.getByText(/not a tamper-proof log/)).toBeTruthy();
    expect(document.querySelectorAll("time")).toHaveLength(7);
    expect(screen.queryByRole("button", { name: /Delete|Retry delivery|Cancel|Save/ })).toBeNull();
  });

  it("keeps a failed refresh explicitly stale rather than replacing it with an empty list", async () => {
    mount();
    await screen.findByText("Succeeded · HTTP 200");
    vi.mocked(api.getAudit).mockRejectedValue(new Error("refresh failed"));
    fireEvent.click(screen.getByRole("button", { name: "Refresh audit trail" }));
    await screen.findByRole("alert");
    expect(screen.getByText(/Last successful audit snapshot \(may be stale\)/)).toBeTruthy();
    expect(screen.getByText("Succeeded · HTTP 200")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Next audit entries" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("paginates with a way back from an empty page caused by retention", async () => {
    vi.mocked(api.getAudit).mockImplementation(async (page) => page === 1
      ? { ...sample, total: 51 }
      : { ...sample, entries: [], total: 1, page: 2 });
    mount();
    await screen.findByText("Succeeded · HTTP 200");
    expect((screen.getByRole("button", { name: "Previous audit entries" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Next audit entries" }));
    expect(await screen.findByText(/No audit entries on this page/)).toBeTruthy();
    expect(api.getAudit).toHaveBeenLastCalledWith(2);
    fireEvent.click(screen.getByRole("button", { name: "Previous audit entries" }));
    expect(await screen.findByText("Succeeded · HTTP 200")).toBeTruthy();
  });

  it("can go back from a later-page error with no cached data", async () => {
    vi.mocked(api.getAudit).mockImplementation(async (page) => {
      if (page === 2) throw new Error("page unavailable");
      return { ...sample, total: 51 };
    });
    mount();
    await screen.findByText("Succeeded · HTTP 200");
    fireEvent.click(screen.getByRole("button", { name: "Next audit entries" }));
    await screen.findByRole("alert");
    fireEvent.click(screen.getByRole("button", { name: "Previous audit entries" }));
    expect(await screen.findByText("Succeeded · HTTP 200")).toBeTruthy();
  });

  it("polls independently while mounted and stops when closed", async () => {
    vi.useFakeTimers();
    const view = mount();
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    await act(async () => { await vi.advanceTimersByTimeAsync(10001); });
    expect(api.getAudit).toHaveBeenCalledTimes(2);
    view.unmount();
    await act(async () => { await vi.advanceTimersByTimeAsync(20000); });
    expect(api.getAudit).toHaveBeenCalledTimes(2);
  });
});
