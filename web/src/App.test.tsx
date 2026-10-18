import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "./App";
import { api, type BotConfig } from "./lib/api";

vi.mock("./lib/api", async (original) => ({
  ...await original<typeof import("./lib/api")>(),
  api: { getConfig: vi.fn(), getChats: vi.fn(), saveConfig: vi.fn() },
}));
vi.mock("@/components/StatusCard", () => ({ StatusCard: () => null }));
vi.mock("@/lib/useStatusStream", () => ({ useStatusStream: () => null }));
vi.mock("@/components/GeneralCard", () => ({
  GeneralCard: ({ config, onChange }: { config: BotConfig; onChange: (patch: Partial<BotConfig>) => void }) =>
    <input aria-label="Prefix" value={config.botReplyPrefix} onChange={(event) => onChange({ botReplyPrefix: event.target.value })} />,
}));

const config = { botReplyPrefix: "original", approvedSenders: [] } as unknown as BotConfig;
const clients: QueryClient[] = [];
beforeEach(() => {
  vi.mocked(api.getConfig).mockResolvedValue({ config, revision: "first" });
  vi.mocked(api.getChats).mockResolvedValue({ chats: [] });
});
afterEach(() => {
  cleanup();
  for (const client of clients.splice(0)) client.clear();
  vi.resetAllMocks();
  vi.restoreAllMocks();
});

function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retryDelay: 0 } } });
  clients.push(client);
  render(<QueryClientProvider client={client}><App /></QueryClientProvider>);
  return client;
}

// The prefix field lives on the General tab; the app opens on Connection.
async function openPrefix() {
  fireEvent.click(await screen.findByRole("button", { name: /General/ }));
  return (await screen.findByLabelText("Prefix")) as HTMLInputElement;
}

describe("configuration editor", () => {
  it("clears dirty state when edits are reverted", async () => {
    mount();
    const input = await openPrefix();
    fireEvent.change(input, { target: { value: "changed" } });
    expect(screen.getByText("Unsaved changes")).toBeTruthy();
    fireEvent.change(input, { target: { value: "original" } });
    await waitFor(() => expect(screen.queryByText("Unsaved changes")).toBeNull());
    expect((screen.getByRole("button", { name: "Save changes" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("shows chat loading rather than an empty directory", async () => {
    vi.mocked(api.getChats).mockReturnValue(new Promise(() => {}));
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Access" }));
    expect(screen.getByText("Loading chats...")).toBeTruthy();
    expect(screen.queryByText("No chats synced yet.")).toBeNull();
    expect((screen.getByRole("button", { name: "Refresh chat list" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("shows chat failures and allows retrying", async () => {
    vi.mocked(api.getChats).mockRejectedValue(new Error("directory offline"));
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Access" }));
    expect((await screen.findByRole("alert")).textContent).toContain("directory offline");
    expect(screen.queryByText("No chats synced yet.")).toBeNull();
    vi.mocked(api.getChats).mockResolvedValue({ chats: [] });
    fireEvent.click(screen.getByRole("button", { name: "Refresh chat list" }));
    expect(await screen.findByText("No chats synced yet.")).toBeTruthy();
  });

  it("orders Connection and General first, with Pets after the existing tabs", async () => {
    mount();
    await screen.findByRole("button", { name: "Connection" });
    expect(within(screen.getByRole("navigation")).getAllByRole("button").map((button) => button.textContent?.trim())).toEqual([
      "Connection", "General", "Access", "AI", "Paint & Film", "Memory & profiles", "Pets", "Sleep",
    ]);
    expect(screen.queryByLabelText("Prefix")).toBeNull();
  });

  it("shows failed loading and a retry action", async () => {
    vi.mocked(api.getConfig).mockRejectedValue(new Error("offline"));
    mount();
    expect((await screen.findByRole("alert")).textContent).toContain("offline");
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
  });

  it("preserves dirty edits when cached server configuration changes", async () => {
    const client = mount();
    const input = await openPrefix();
    fireEvent.change(input, { target: { value: "unsaved" } });
    act(() => client.setQueryData(["config"], { config: { ...config, botReplyPrefix: "remote" }, revision: "second" }));
    expect(input.value).toBe("unsaved");
  });

  it("preserves edits and displays a rejected save", async () => {
    vi.mocked(api.saveConfig).mockRejectedValue(new Error("Configuration changed elsewhere"));
    mount();
    const input = await openPrefix();
    fireEvent.change(input, { target: { value: "unsaved" } });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    expect((await screen.findByRole("alert")).textContent).toContain("changed elsewhere");
    expect(input.value).toBe("unsaved");
    expect(api.saveConfig).toHaveBeenCalledWith({ config: { ...config, botReplyPrefix: "unsaved" }, revision: "first" });
  });

  it("does not reload when discarding edits is cancelled", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(false);
    mount();
    fireEvent.change(await openPrefix(), { target: { value: "unsaved" } });
    fireEvent.click(screen.getByRole("button", { name: "Reload" }));
    expect(api.getConfig).toHaveBeenCalledTimes(1);
  });

  it("uses the saved revision and clears dirty state after success", async () => {
    vi.mocked(api.saveConfig).mockResolvedValue({ config: { ...config, botReplyPrefix: "saved" }, revision: "second" });
    mount();
    fireEvent.change(await openPrefix(), { target: { value: "saved" } });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(screen.queryByText("Unsaved changes")).toBeNull());
    expect((screen.getByLabelText("Prefix") as HTMLInputElement).value).toBe("saved");
  });
});