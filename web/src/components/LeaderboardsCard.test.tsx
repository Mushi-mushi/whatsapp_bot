import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, type LeaderboardsResponse } from "@/lib/api";
import { LeaderboardsCard } from "./LeaderboardsCard";

const sample: LeaderboardsResponse = {
  sampledAt: 1700000000000,
  chats: [
    {
      chatId: "first@g.us",
      chatName: "Friends",
      trivia: {
        monthly: [{ senderId: "34600000001@s.whatsapp.net", name: "Alice", score: 7 }],
        allTime: [{ senderId: "34600000001@s.whatsapp.net", name: "Alice", score: 15 }],
        trophies: [{ senderId: "34600000001@s.whatsapp.net", name: "Alice", trophies: 2 }],
        history: [{ period: "2026-09", senderId: "34600000001@s.whatsapp.net", name: "Alice", score: 8 }],
      },
      duel: {
        monthly: [{ senderId: "34600000002@s.whatsapp.net", name: "Bob", score: 3 }],
        allTime: [{ senderId: "34600000002@s.whatsapp.net", name: "Bob", score: 5 }],
        trophies: [],
        history: [],
      },
      karma: [{ senderId: "34600000001@s.whatsapp.net", name: "Alice", score: 12 }],
      participants: [{ senderId: "34600000001@s.whatsapp.net", name: "Alice", lastSeenAt: 1700000000000 }],
    },
    {
      chatId: "second@g.us",
      chatName: "Work",
      trivia: { monthly: [], allTime: [], trophies: [], history: [] },
      duel: { monthly: [], allTime: [], trophies: [], history: [] },
      karma: [],
      participants: [],
    },
  ],
};

const clients: QueryClient[] = [];
beforeEach(() => {
  vi.spyOn(api, "getLeaderboards").mockResolvedValue(sample);
});
afterEach(() => {
  cleanup();
  for (const client of clients.splice(0)) client.clear();
  vi.restoreAllMocks();
});

function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  clients.push(client);
  return render(<QueryClientProvider client={client}><LeaderboardsCard /></QueryClientProvider>);
}

describe("LeaderboardsCard", () => {
  it("renders trivia, duel, karma, trophies and last-seen activity and switches chats", async () => {
    mount();
    expect(await screen.findByText("7 pts")).toBeTruthy();
    expect(screen.getByText("15 pts")).toBeTruthy();
    expect(screen.getByText("2 trophies")).toBeTruthy();
    expect(screen.getByText("3 wins")).toBeTruthy();
    expect(screen.getByText("12 karma")).toBeTruthy();

    fireEvent.change(screen.getByLabelText("Chat"), { target: { value: "second@g.us" } });
    expect(screen.getByText("No trivia points this month.")).toBeTruthy();
    expect(screen.getByText("No participant activity observed in this chat yet.")).toBeTruthy();
  });
});
