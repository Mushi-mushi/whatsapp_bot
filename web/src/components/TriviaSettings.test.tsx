import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "@/lib/api";
import { TriviaSettings } from "./TriviaSettings";

const clients: QueryClient[] = [];
beforeEach(() => {
  vi.spyOn(api, "getChats").mockResolvedValue({ chats: [{ id: "friends@g.us", name: "Friends" }, { id: "work@g.us", name: "Work" }] });
  vi.spyOn(api, "getTriviaSettings").mockResolvedValue({ categories: [{ id: 21, name: "Sports" }, { id: 23, name: "History" }],
    bans: [{ chatId: "friends@g.us", categoryId: 21, until: Date.now() + 86_400_000 }], sampledAt: Date.now() });
  vi.spyOn(api, "banTriviaCategory").mockResolvedValue({ ok: true, announcementQueued: true, ban: { chatId: "friends@g.us", categoryId: 23, until: Date.now() + 3 * 86_400_000 } });
  vi.spyOn(api, "unbanTriviaCategory").mockResolvedValue({ ok: true });
});
afterEach(() => { cleanup(); for (const client of clients.splice(0)) client.clear(); vi.restoreAllMocks(); });
function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  clients.push(client);
  render(<QueryClientProvider client={client}><TriviaSettings /></QueryClientProvider>);
}

describe("TriviaSettings", () => {
  it("bans a category for a selected duration and confirms the queued announcement", async () => {
    mount();
    await screen.findByLabelText("Category");
    fireEvent.change(screen.getByLabelText("Category"), { target: { value: "23" } });
    fireEvent.change(screen.getByLabelText("Days"), { target: { value: "3" } });
    fireEvent.click(screen.getByRole("button", { name: "Ban & announce" }));
    await screen.findByText("Category banned. Announcement queued.");
    expect(api.banTriviaCategory).toHaveBeenCalledWith({ chatId: "friends@g.us", categoryId: 23, days: 3 });
  });
  it("scopes the ban list to a chat and supports early unbanning", async () => {
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Unban Sports" }));
    await waitFor(() => expect(vi.mocked(api.unbanTriviaCategory).mock.calls[0]?.[0]).toEqual({ chatId: "friends@g.us", categoryId: 21 }));
    await screen.findByText("Category available again.");
    fireEvent.change(screen.getByLabelText("Chat"), { target: { value: "work@g.us" } });
    expect(screen.queryByRole("button", { name: "Unban Sports" })).toBeNull();
  });
  it("rejects fractional durations and displays server failures", async () => {
    vi.mocked(api.banTriviaCategory).mockRejectedValue(new Error("Could not save ban"));
    mount();
    await screen.findByLabelText("Days");
    fireEvent.change(screen.getByLabelText("Days"), { target: { value: "1.5" } });
    expect(screen.getByRole("button", { name: "Ban & announce" }).hasAttribute("disabled")).toBe(true);
    fireEvent.change(screen.getByLabelText("Days"), { target: { value: "2" } });
    fireEvent.click(screen.getByRole("button", { name: "Ban & announce" }));
    expect(await screen.findByText("Could not save ban")).toBeTruthy();
    expect(screen.queryByText("Category banned. Announcement queued.")).toBeNull();
  });
});