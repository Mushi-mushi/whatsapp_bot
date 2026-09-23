import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "./App";
import { api, type BotConfig } from "./lib/api";

vi.mock("./lib/api", async (original) => ({
  ...await original<typeof import("./lib/api")>(),
  api: { getConfig: vi.fn(), getChats: vi.fn(), saveConfig: vi.fn() },
}));
vi.mock("@/components/StatusCard", () => ({ StatusCard: () => null }));
vi.mock("@/components/ApprovedSenders", () => ({ ApprovedSenders: () => null }));
vi.mock("@/components/SettingsCard", () => ({
  SettingsCard: ({ config, onChange }: { config: BotConfig; onChange: (patch: Partial<BotConfig>) => void }) =>
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

describe("configuration editor", () => {
  it("shows failed loading and a retry action", async () => {
    vi.mocked(api.getConfig).mockRejectedValue(new Error("offline"));
    mount();
    expect((await screen.findByRole("alert")).textContent).toContain("offline");
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
  });

  it("preserves dirty edits when cached server configuration changes", async () => {
    const client = mount();
    const input = await screen.findByLabelText("Prefix") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "unsaved" } });
    act(() => client.setQueryData(["config"], { config: { ...config, botReplyPrefix: "remote" }, revision: "second" }));
    expect(input.value).toBe("unsaved");
  });

  it("preserves edits and displays a rejected save", async () => {
    vi.mocked(api.saveConfig).mockRejectedValue(new Error("Configuration changed elsewhere"));
    mount();
    const input = await screen.findByLabelText("Prefix") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "unsaved" } });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    expect((await screen.findByRole("alert")).textContent).toContain("changed elsewhere");
    expect(input.value).toBe("unsaved");
    expect(api.saveConfig).toHaveBeenCalledWith({ config: { ...config, botReplyPrefix: "unsaved" }, revision: "first" });
  });

  it("does not reload when discarding edits is cancelled", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(false);
    mount();
    fireEvent.change(await screen.findByLabelText("Prefix"), { target: { value: "unsaved" } });
    fireEvent.click(screen.getByRole("button", { name: "Reload" }));
    expect(api.getConfig).toHaveBeenCalledTimes(1);
  });

  it("uses the saved revision and clears dirty state after success", async () => {
    vi.mocked(api.saveConfig).mockResolvedValue({ config: { ...config, botReplyPrefix: "saved" }, revision: "second" });
    mount();
    fireEvent.change(await screen.findByLabelText("Prefix"), { target: { value: "saved" } });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(screen.queryByText("Unsaved changes")).toBeNull());
    expect((screen.getByLabelText("Prefix") as HTMLInputElement).value).toBe("saved");
  });
});