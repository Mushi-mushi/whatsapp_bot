import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, ApiError, type TellsResponse } from "@/lib/api";
import { PendingTellsCard } from "./PendingTellsCard";

const sample: TellsResponse = {
  tells: [
    { id: 1, targetName: "Alice", fromName: "Bob", text: "Call me", createdAt: 1000,
      chatId: "group@g.us", chatName: "Friends", targetId: "34600000001@s.whatsapp.net", legacy: false },
    { id: 2, targetName: "Alice", fromName: "Carol", text: "<script>literal text</script>\nsecond line", createdAt: 2000,
      chatId: null, chatName: null, targetId: null, legacy: true },
  ], total: 2, page: 1, pageSize: 50, sampledAt: 3000,
};
const empty = { ...sample, tells: [], total: 0 };
const clients: QueryClient[] = [];
beforeEach(() => {
  vi.spyOn(api, "getTells").mockResolvedValue(sample);
  vi.spyOn(api, "cancelTell").mockResolvedValue({ ok: true, cancelledId: 1 });
  vi.spyOn(api, "getReminders");
  vi.spyOn(window, "confirm").mockReturnValue(true);
});
afterEach(() => {
  cleanup();
  clients.splice(0).forEach((client) => client.clear());
  vi.restoreAllMocks();
});
function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  clients.push(client);
  render(<QueryClientProvider client={client}><PendingTellsCard /></QueryClientProvider>);
}

describe("pending tells", () => {
  it("shows named sender/recipient, creation time and literal text without inventing chat identities", async () => {
    mount();
    await screen.findByText("Call me");
    expect(screen.getAllByRole("heading", { name: "Recipient: Alice" })).toHaveLength(2);
    expect(screen.getByText("From: Bob")).toBeTruthy();
    expect(screen.getByText(/<script>literal text/).textContent).toContain("\nsecond line");
    expect(document.querySelector("script")).toBeNull();
    expect(document.querySelectorAll("time")).toHaveLength(2);
    expect(screen.getByText(/New tells are bound to a person in one chat/)).toBeTruthy();
    expect(screen.getByText("Chat: Friends")).toBeTruthy();
    expect(screen.getByText("Identity: 34600000001@s.whatsapp.net")).toBeTruthy();
    expect(screen.getByText(/Legacy tell — held/)).toBeTruthy();
    expect(api.getReminders).not.toHaveBeenCalled();
  });

  it("distinguishes loading, initial errors and an empty successful list", async () => {
    vi.mocked(api.getTells).mockReturnValueOnce(new Promise(() => {}));
    mount();
    expect(screen.getByRole("status").textContent).toContain("Loading tells");
    expect(screen.queryByText("No pending tells.")).toBeNull();
    cleanup();
    vi.mocked(api.getTells).mockRejectedValue(new Error("offline"));
    mount();
    expect((await screen.findByRole("alert")).textContent).toContain("offline");
    vi.mocked(api.getTells).mockResolvedValue(empty);
    fireEvent.click(screen.getByRole("button", { name: "Retry tells" }));
    expect(await screen.findByText("No pending tells.")).toBeTruthy();
  });

  it("requires confirmation and disables actions during cancellation", async () => {
    vi.mocked(window.confirm).mockReturnValue(false);
    mount();
    await screen.findByText("Call me");
    fireEvent.click(screen.getByRole("button", { name: "Cancel tell 1" }));
    expect(api.cancelTell).not.toHaveBeenCalled();
    vi.mocked(window.confirm).mockReturnValue(true);
    vi.mocked(api.cancelTell).mockReturnValue(new Promise(() => {}));
    fireEvent.click(screen.getByRole("button", { name: "Cancel tell 1" }));
    await waitFor(() => expect((screen.getByRole("button", { name: "Cancel tell 2" }) as HTMLButtonElement).disabled).toBe(true));
    expect(api.cancelTell).toHaveBeenCalledWith(1);
  });

  it("keeps confirmed cancellations removed even when the subsequent refresh fails", async () => {
    mount();
    await screen.findByText("Call me");
    vi.mocked(api.getTells).mockRejectedValue(new Error("refresh failed"));
    fireEvent.click(screen.getByRole("button", { name: "Cancel tell 1" }));
    expect(await screen.findByText("Tell #1 cancelled before delivery.")).toBeTruthy();
    await screen.findByRole("alert");
    expect(screen.queryByText("Call me")).toBeNull();
    expect(screen.getByText(/Last successful tell snapshot \(may be stale\)/)).toBeTruthy();
    expect((screen.getByRole("button", { name: "Cancel tell 2" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("reports an outbox handoff conflict without false success and refetches", async () => {
    vi.mocked(api.cancelTell).mockRejectedValue(new ApiError(409, "Tell is no longer pending; no delivery was cancelled."));
    mount();
    await screen.findByText("Call me");
    vi.mocked(api.getTells).mockResolvedValue(empty);
    fireEvent.click(screen.getByRole("button", { name: "Cancel tell 1" }));
    expect((await screen.findByRole("alert")).textContent).toContain("no delivery was cancelled");
    expect(await screen.findByText("No pending tells.")).toBeTruthy();
    expect(screen.queryByText("Tell #1 cancelled before delivery.")).toBeNull();
  });

  it("can return from a failed later page and does not mix reminder or tell caches", async () => {
    vi.mocked(api.getTells).mockImplementation(async (page) => {
      if (page === 2) throw new Error("page unavailable");
      return { ...sample, total: 51 };
    });
    mount();
    await screen.findByText("Call me");
    fireEvent.click(screen.getByRole("button", { name: "Next tells" }));
    await screen.findByRole("alert");
    fireEvent.click(screen.getByRole("button", { name: "Previous tells" }));
    expect(await screen.findByText("Call me")).toBeTruthy();
    expect(api.getReminders).not.toHaveBeenCalled();
  });
});
