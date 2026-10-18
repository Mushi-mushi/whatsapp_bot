import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, ApiError, type RemindersResponse } from "@/lib/api";
import { RemindersCard } from "./RemindersCard";

const sample: RemindersResponse = {
  total: 2, page: 1, pageSize: 50, sampledAt: 1700000000000,
  reminders: [
    { id: 1, chatId: "first@g.us", chatName: "Friends", targetName: "Alice", text: "Water plants", dueAt: 1700000060000 },
    { id: 2, chatId: "second@g.us", chatName: "Friends", targetName: null, text: "<script>plain text</script>\nsecond line", dueAt: 1699999990000 },
  ],
};
const empty: RemindersResponse = { ...sample, reminders: [], total: 0 };
const clients: QueryClient[] = [];
beforeEach(() => {
  vi.spyOn(api, "getReminders").mockResolvedValue(sample);
  vi.spyOn(api, "cancelReminder").mockResolvedValue({ ok: true, cancelledId: 1 });
  vi.spyOn(window, "confirm").mockReturnValue(true);
});
afterEach(() => {
  cleanup();
  for (const client of clients.splice(0)) client.clear();
  vi.restoreAllMocks();
  vi.useRealTimers();
});
function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  clients.push(client);
  const view = render(<QueryClientProvider client={client}><RemindersCard /></QueryClientProvider>);
  return { client, view };
}
const cancel = (id: number) => screen.getByRole("button", { name: `Cancel reminder ${id}` });

describe("scheduled reminders", () => {
  it("shows loading without a misleading empty list", () => {
    vi.mocked(api.getReminders).mockReturnValue(new Promise(() => {}));
    mount();
    expect(screen.getByRole("status").textContent).toContain("Loading reminders");
    expect(screen.queryByText("No scheduled reminders.")).toBeNull();
    expect((screen.getByRole("button", { name: "Refresh reminders" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("distinguishes a query error, retry and successful empty list", async () => {
    vi.mocked(api.getReminders).mockRejectedValue(new Error("offline"));
    mount();
    expect((await screen.findByRole("alert")).textContent).toContain("offline");
    expect(screen.queryByText("No scheduled reminders.")).toBeNull();
    vi.mocked(api.getReminders).mockResolvedValue(empty);
    fireEvent.click(screen.getByRole("button", { name: "Retry reminders" }));
    expect(await screen.findByText("No scheduled reminders.")).toBeTruthy();
  });

  it("renders chat IDs alongside duplicate names, recipient fallback, due states and literal multiline message text", async () => {
    mount();
    await screen.findByText("Water plants");
    expect(screen.getAllByRole("heading", { name: "Friends" })).toHaveLength(2);
    expect(screen.getByText("first@g.us")).toBeTruthy();
    expect(screen.getByText("second@g.us")).toBeTruthy();
    expect(screen.getByText("Recipient: Alice")).toBeTruthy();
    expect(screen.getByText("Recipient: Chat (no named recipient)")).toBeTruthy();
    expect(screen.getByText(/<script>plain text<\/script>/).textContent).toContain("\nsecond line");
    expect(document.querySelector("script")).toBeNull();
    expect(screen.getByText(/Due now or overdue/)).toBeTruthy();
    expect(screen.getByText(/Scheduled; not yet queued/)).toBeTruthy();
    expect(document.querySelectorAll("time")).toHaveLength(2);
  });

  it("uses an unknown-chat fallback and confirms before cancelling", async () => {
    vi.mocked(api.getReminders).mockResolvedValue({ ...sample, reminders: [{ ...sample.reminders[0], chatName: null }] });
    vi.mocked(window.confirm).mockReturnValue(false);
    mount();
    await screen.findByText("Unknown chat");
    fireEvent.click(cancel(1));
    expect(window.confirm).toHaveBeenCalledWith(expect.stringContaining("cannot be undone"));
    expect(api.cancelReminder).not.toHaveBeenCalled();
  });

  it("removes only a successfully cancelled row and refetches the scheduler", async () => {
    mount();
    await screen.findByText("Water plants");
    vi.mocked(api.getReminders).mockResolvedValue({ ...sample, total: 1, reminders: [sample.reminders[1]] });
    fireEvent.click(cancel(1));
    expect(await screen.findByText("Reminder #1 cancelled before delivery.")).toBeTruthy();
    await waitFor(() => expect(screen.queryByText("Water plants")).toBeNull());
    expect(screen.getByText(/<script>plain text<\/script>/)).toBeTruthy();
    expect(api.cancelReminder).toHaveBeenCalledWith(1);
    expect(api.getReminders).toHaveBeenCalledTimes(2);
  });

  it("keeps all actions disabled while cancellation is pending", async () => {
    vi.mocked(api.cancelReminder).mockReturnValue(new Promise(() => {}));
    mount();
    await screen.findByText("Water plants");
    fireEvent.click(cancel(1));
    await waitFor(() => expect((cancel(2) as HTMLButtonElement).disabled).toBe(true));
    expect(cancel(1).textContent).toBe("Cancelling...");
    expect((screen.getByRole("button", { name: "Refresh reminders" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("reports a handoff conflict without success and refreshes out-of-date scheduled entries", async () => {
    vi.mocked(api.cancelReminder).mockRejectedValue(new ApiError(409, "Reminder is no longer scheduled; no delivery was cancelled."));
    mount();
    await screen.findByText("Water plants");
    vi.mocked(api.getReminders).mockResolvedValue(empty);
    fireEvent.click(cancel(1));
    expect((await screen.findByRole("alert")).textContent).toContain("no delivery was cancelled");
    expect(screen.queryByText("Reminder #1 cancelled before delivery.")).toBeNull();
    expect(await screen.findByText("No scheduled reminders.")).toBeTruthy();
  });

  it("keeps the reminder and an explicit error if cancellation fails", async () => {
    vi.mocked(api.cancelReminder).mockRejectedValue(new Error("server unavailable"));
    mount();
    await screen.findByText("Water plants");
    fireEvent.click(cancel(1));
    expect((await screen.findByRole("alert")).textContent).toContain("server unavailable");
    expect(screen.getByText("Water plants")).toBeTruthy();
    expect(screen.queryByText(/cancelled before delivery/)).toBeNull();
  });

  it("marks failed background refresh data stale and disables stale cancellation controls", async () => {
    mount();
    await screen.findByText("Water plants");
    vi.mocked(api.getReminders).mockRejectedValue(new Error("refresh failed"));
    fireEvent.click(screen.getByRole("button", { name: "Refresh reminders" }));
    await screen.findByRole("alert");
    expect(screen.getByText(/Last successful reminder snapshot \(may be stale\)/)).toBeTruthy();
    expect(screen.getByText("Water plants")).toBeTruthy();
    expect((cancel(1) as HTMLButtonElement).disabled).toBe(true);
  });

  it("paginates and supports returning from a page emptied by delivery handoffs", async () => {
    vi.mocked(api.getReminders).mockImplementation(async (page) => page === 1
      ? { ...sample, total: 51 }
      : { ...sample, page: 2, total: 1, reminders: [] });
    mount();
    await screen.findByText("Water plants");
    expect((screen.getByRole("button", { name: "Previous reminders" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Next reminders" }));
    expect(await screen.findByText(/No reminders on this page/)).toBeTruthy();
    expect(api.getReminders).toHaveBeenLastCalledWith(2);
    fireEvent.click(screen.getByRole("button", { name: "Previous reminders" }));
    expect(await screen.findByText("Water plants")).toBeTruthy();
  });

  it("polls only while mounted", async () => {
    vi.useFakeTimers();
    const { view } = mount();
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(api.getReminders).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(10000); });
    expect(api.getReminders).toHaveBeenCalledTimes(2);
    view.unmount();
    await act(async () => { await vi.advanceTimersByTimeAsync(20000); });
    expect(api.getReminders).toHaveBeenCalledTimes(2);
  });

  it("lets the user return to page one when a later page fails to load", async () => {
    vi.mocked(api.getReminders).mockImplementation(async (page) => {
      if (page === 2) throw new Error("Page unavailable");
      return { ...sample, total: 51 };
    });
    mount();
    await screen.findByText("Water plants");
    fireEvent.click(screen.getByRole("button", { name: "Next reminders" }));
    expect((await screen.findByRole("alert")).textContent).toContain("Page unavailable");
    fireEvent.click(screen.getByRole("button", { name: "Previous reminders" }));
    expect(await screen.findByText("Water plants")).toBeTruthy();
  });

  it("does not resurrect a successfully cancelled row if the following refresh fails", async () => {
    mount();
    await screen.findByText("Water plants");
    vi.mocked(api.getReminders).mockRejectedValue(new Error("Refresh unavailable"));
    fireEvent.click(cancel(1));
    expect(await screen.findByText("Reminder #1 cancelled before delivery.")).toBeTruthy();
    await screen.findByRole("alert");
    expect(screen.queryByText("Water plants")).toBeNull();
    expect(screen.getByText(/Last successful reminder snapshot \(may be stale\)/)).toBeTruthy();
  });
});
