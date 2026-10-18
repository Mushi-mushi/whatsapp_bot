import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "@/lib/api";
import { DisciplineCard } from "./DisciplineCard";

const clients: QueryClient[] = [];
beforeEach(() => {
  vi.spyOn(api, "getDiscipline").mockResolvedValue({ players: [] });
  vi.spyOn(api, "getContacts").mockResolvedValue({ contacts: [] });
});
afterEach(() => {
  cleanup();
  for (const client of clients.splice(0)) client.clear();
  vi.restoreAllMocks();
});
function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  clients.push(client);
  render(<QueryClientProvider client={client}><DisciplineCard chats={[]} /></QueryClientProvider>);
}

describe("discipline query and form states", () => {
  it.each(["ask", "siesta"] as const)("confirms and resets %s for the selected user across all chats without requiring a chat", async (command) => {
    const reset = vi.spyOn(api, "resetUsage").mockResolvedValue({ ok: true, command });
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    mount();
    await screen.findByText("No players are sleeping or armed.");
    const button = screen.getByRole("button", { name: `Reset bot.${command} count` }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Player"), { target: { value: "34600000001@s.whatsapp.net" } });
    expect(button.disabled).toBe(false);
    fireEvent.click(button);
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining("ALL chats"));
    await waitFor(() => expect(reset).toHaveBeenCalledWith({ senderId: "34600000001@s.whatsapp.net", command }));
    expect(await screen.findByText(`Reset bot.${command} usage for 34600000001@s.whatsapp.net across all chats.`)).toBeTruthy();
  });

  it("does not reset when confirmation is declined and surfaces API errors", async () => {
    const reset = vi.spyOn(api, "resetUsage").mockRejectedValue(new Error("Reset unavailable"));
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    mount();
    await screen.findByText("No players are sleeping or armed.");
    fireEvent.change(screen.getByLabelText("Player"), { target: { value: "34600000001@s.whatsapp.net" } });
    fireEvent.click(screen.getByRole("button", { name: "Reset bot.ask count" }));
    expect(reset).not.toHaveBeenCalled();
    confirm.mockReturnValue(true);
    fireEvent.click(screen.getByRole("button", { name: "Reset bot.ask count" }));
    expect((await screen.findByRole("alert")).textContent).toContain("Reset unavailable");
  });

  it("resolves device phone addresses but never treats opaque LID digits as a phone number", async () => {
    vi.mocked(api.getContacts).mockResolvedValue({
      contacts: [{ jid: "34600000001@s.whatsapp.net", phone: "34600000001", name: "Alice" }],
    });
    mount();
    await screen.findByText("No players are sleeping or armed.");
    const player = screen.getByLabelText("Player");
    fireEvent.change(player, { target: { value: "34600000001:2@s.whatsapp.net" } });
    expect(await screen.findByText("Resolved: Alice")).toBeTruthy();
    fireEvent.change(player, { target: { value: "34600000001@lid" } });
    expect(screen.getByText("Unknown contact — the JID will be used as-is")).toBeTruthy();
    expect(screen.queryByText("Resolved: Alice")).toBeNull();
  });

  it("shows loading instead of claiming there are no active players", () => {
    vi.mocked(api.getDiscipline).mockReturnValue(new Promise(() => {}));
    vi.mocked(api.getContacts).mockReturnValue(new Promise(() => {}));
    mount();
    expect(screen.getByText("Loading players...").getAttribute("role")).toBe("status");
    expect(screen.getByText("Loading contacts...").getAttribute("role")).toBe("status");
    expect(screen.queryByText("No players are sleeping or armed.")).toBeNull();
  });

  it("shows failures instead of an empty result and supports retry", async () => {
    vi.mocked(api.getDiscipline).mockRejectedValue(new Error("players offline"));
    mount();
    expect((await screen.findByRole("alert")).textContent).toContain("players offline");
    expect(screen.queryByText("No players are sleeping or armed.")).toBeNull();
    vi.mocked(api.getDiscipline).mockResolvedValue({ players: [] });
    fireEvent.click(screen.getByRole("button", { name: "Retry players" }));
    expect(await screen.findByText("No players are sleeping or armed.")).toBeTruthy();
  });

  it("reports contact failures without preventing manually entered IDs", async () => {
    vi.mocked(api.getContacts).mockRejectedValue(new Error("contacts offline"));
    const arm = vi.spyOn(api, "armPlayer").mockResolvedValue({ ok: true, players: [] });
    mount();
    expect((await screen.findByRole("alert")).textContent).toContain("contacts offline");
    expect(screen.getByRole("button", { name: "Retry contacts" })).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Chat"), { target: { value: "group@g.us" } });
    fireEvent.change(screen.getByLabelText("Player"), { target: { value: "123@s.whatsapp.net" } });
    fireEvent.click(screen.getByRole("button", { name: "Arm next siesta" }));
    await waitFor(() => expect(arm).toHaveBeenCalledWith("group@g.us", "123@s.whatsapp.net"));
  });

  it.each(["", "0", "61", "1.5"])("refuses invalid sleep duration %j without clamping it", async (value) => {
    const sleep = vi.spyOn(api, "sleepPlayer").mockResolvedValue({ ok: true, players: [] });
    mount();
    await screen.findByText("No players are sleeping or armed.");
    fireEvent.change(screen.getByLabelText("Chat"), { target: { value: "group@g.us" } });
    fireEvent.change(screen.getByLabelText("Player"), { target: { value: "123@s.whatsapp.net" } });
    const duration = screen.getByRole("spinbutton") as HTMLInputElement;
    fireEvent.change(duration, { target: { value } });
    expect(duration.value).toBe(value);
    expect(screen.getByRole("alert").textContent).toContain("whole number");
    expect((screen.getByRole("button", { name: "Put to sleep now" }) as HTMLButtonElement).disabled).toBe(true);
    expect(sleep).not.toHaveBeenCalled();
    fireEvent.change(duration, { target: { value: "15" } });
    fireEvent.click(screen.getByRole("button", { name: "Put to sleep now" }));
    await waitFor(() => expect(sleep).toHaveBeenCalledWith("group@g.us", "123@s.whatsapp.net", 15));
  });
});
