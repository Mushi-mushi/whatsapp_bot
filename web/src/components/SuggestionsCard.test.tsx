import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, type SuggestionsResponse } from "@/lib/api";
import { SuggestionsCard } from "./SuggestionsCard";

const sample: SuggestionsResponse = {
  total: 2,
  page: 1,
  pageSize: 50,
  sampledAt: 1700000000000,
  suggestions: [
    {
      id: 2,
      createdAt: 1700000000000,
      chatId: "first@g.us",
      chatName: "Friends",
      senderId: "34600000001@s.whatsapp.net",
      senderName: "Alice",
      kind: "unknown_command",
      command: "bot.dance",
      text: "bot.dance salsa",
    },
    {
      id: 1,
      createdAt: 1699999900000,
      chatId: "first@g.us",
      chatName: "Friends",
      senderId: "34600000002@s.whatsapp.net",
      senderName: "Bob",
      kind: "explicit",
      command: null,
      text: "Add a daily horoscope",
    },
  ],
};

const clients: QueryClient[] = [];
beforeEach(() => {
  vi.spyOn(api, "getSuggestions").mockResolvedValue(sample);
  vi.spyOn(api, "deleteSuggestion").mockResolvedValue({ ok: true, deletedId: 2 });
});
afterEach(() => {
  cleanup();
  for (const client of clients.splice(0)) client.clear();
  vi.restoreAllMocks();
});

function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  clients.push(client);
  return render(<QueryClientProvider client={client}><SuggestionsCard /></QueryClientProvider>);
}

describe("SuggestionsCard", () => {
  it("renders explicit and unrecognized command suggestions and dismisses entries", async () => {
    mount();
    expect(await screen.findByText("bot.dance salsa")).toBeTruthy();
    expect(screen.getByText("Unrecognized command (bot.dance)")).toBeTruthy();
    expect(screen.getByText("Explicit (bot.suggest)")).toBeTruthy();
    expect(screen.getByText("Add a daily horoscope")).toBeTruthy();

    vi.mocked(api.getSuggestions).mockResolvedValue({
      ...sample,
      total: 1,
      suggestions: [sample.suggestions[1]],
    });
    fireEvent.click(screen.getByRole("button", { name: "Dismiss suggestion 2" }));
    expect(await screen.findByText("Suggestion #2 dismissed.")).toBeTruthy();
    await waitFor(() => expect(screen.queryByText("bot.dance salsa")).toBeNull());
    expect(api.deleteSuggestion).toHaveBeenCalledWith(2);
  });
});
