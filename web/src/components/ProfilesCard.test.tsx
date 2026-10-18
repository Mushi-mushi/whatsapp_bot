import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "@/lib/api";
import { ProfilesCard } from "./ProfilesCard";

const profile = { sender_key: '["group@g.us","alice"]', chat_id: "group@g.us", chat_name: "Friends", name: "Alice", short: "Likes hiking", updated_at: Date.now(), messageCount: 5 };
const clients: QueryClient[] = [];

beforeEach(() => {
  vi.spyOn(api, "getProfiles").mockResolvedValue({ profiles: [profile] });
});
afterEach(() => {
  cleanup();
  for (const client of clients.splice(0)) client.clear();
  vi.restoreAllMocks();
});

function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  clients.push(client);
  render(<QueryClientProvider client={client}><ProfilesCard /></QueryClientProvider>);
  return client;
}

describe("profile error states", () => {
  it("distinguishes identical person and chat names and deletes only the chosen scoped entry", async () => {
    const other = { ...profile, sender_key: '["other@g.us","alice"]', chat_id: "other@g.us" };
    vi.mocked(api.getProfiles).mockResolvedValue({ profiles: [profile, other] });
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const forget = vi.spyOn(api, "deleteProfile").mockResolvedValue({ ok: true });
    mount();
    const buttons = await screen.findAllByTitle("Forget this user");
    expect(screen.getByText("(group@g.us)")).toBeTruthy();
    expect(screen.getByText("(other@g.us)")).toBeTruthy();
    fireEvent.click(buttons[1]);
    expect(window.confirm).toHaveBeenCalledWith(expect.stringContaining("in Friends"));
    expect(window.confirm).toHaveBeenCalledWith(expect.stringContaining("(other@g.us)"));
    expect(window.confirm).toHaveBeenCalledWith(expect.stringContaining("this chat only"));
    await waitFor(() => expect(forget).toHaveBeenCalledWith(other.sender_key));
  });

  it("shows failed dossier loading and supports retry", async () => {
    const get = vi.spyOn(api, "getProfile").mockRejectedValue(new Error("dossier unavailable"));
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Expand" }));
    expect((await screen.findByRole("alert")).textContent).toContain("dossier unavailable");
    get.mockResolvedValue({ ...profile, deep: "Recovered dossier", last_profiled_id: 5 });
    fireEvent.click(screen.getByRole("button", { name: "Retry dossier" }));
    expect(await screen.findByText("Recovered dossier")).toBeTruthy();
  });

  it("shows a failed deletion without hiding the user", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    vi.spyOn(api, "deleteProfile").mockRejectedValue(new Error("forget failed"));
    mount();
    fireEvent.click(await screen.findByTitle("Forget this user"));
    expect((await screen.findByRole("alert")).textContent).toContain("forget failed");
    expect(screen.getByText("Alice")).toBeTruthy();
  });

  it("does not show a successful empty state when the list failed", async () => {
    vi.mocked(api.getProfiles).mockRejectedValue(new Error("profiles offline"));
    mount();
    expect((await screen.findByRole("alert")).textContent).toContain("profiles offline");
    expect(screen.queryByText(/No profiles yet/)).toBeNull();
  });
});
