import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "./App";
import { api, type BotConfig } from "./lib/api";
import { config } from "@/test/fixtures";

vi.mock("./lib/api", async (original) => ({
  ...await original<typeof import("./lib/api")>(),
  api: { getConfig: vi.fn(), getChats: vi.fn(), saveConfig: vi.fn(), getOperations: vi.fn() },
}));
vi.mock("@/components/StatusCard", () => ({ StatusCard: () => null }));
vi.mock("@/components/ServiceDiagnostics", () => ({ ServiceDiagnostics: () => null }));
vi.mock("@/lib/useStatusStream", () => ({ useStatusStream: () => null }));
vi.mock("@/components/PetsCard", async () => {
  const { useState } = await import("react");
  return { PetsCard: () => {
    const [name, setName] = useState("Mochi");
    return <input aria-label="Pet draft" value={name} onChange={(event) => setName(event.target.value)} />;
  } };
});
vi.mock("@/components/GeneralCard", async () => {
  const { NumberField } = await import("@/components/fields");
  return {
    GeneralCard: ({ config, onChange }: { config: BotConfig; onChange: (patch: Partial<BotConfig>) => void }) =>
      <>
        <input aria-label="Prefix" value={config.botReplyPrefix} onChange={(event) => onChange({ botReplyPrefix: event.target.value })} />
        <NumberField label="Timeout" value={config.transcriptionTimeoutSeconds} min={5}
          onChange={(value) => onChange({ transcriptionTimeoutSeconds: value })} />
        <NumberField label="Analytics retention (days)" value={config.analyticsRetentionDays} min={1} max={3650}
          onChange={(value) => onChange({ analyticsRetentionDays: value })} />
      </>,
  };
});

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
  it("tracks retention edits on General, blocks invalid drafts and saves with the existing revision", async () => {
    mount();
    await openPrefix();
    const field = screen.getByRole("spinbutton", { name: "Analytics retention (days)" });
    fireEvent.change(field, { target: { value: "180" } });
    expect(within(screen.getByRole("button", { name: /General/ })).getByTitle("Unsaved changes")).toBeTruthy();
    fireEvent.change(field, { target: { value: "0" } });
    expect((screen.getByRole("button", { name: "Save changes" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Operations" }));
    expect(document.activeElement).toBe(field);
    fireEvent.change(field, { target: { value: "180" } });
    vi.mocked(api.saveConfig).mockResolvedValue({ config: { ...config, analyticsRetentionDays: 180 }, revision: "second" });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(api.saveConfig).toHaveBeenCalledWith({
      config: { ...config, analyticsRetentionDays: 180 }, revision: "first",
    }));
    await waitFor(() => expect(screen.queryByText("Unsaved changes")).toBeNull());
  });
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
      "Connection", "General", "Access", "AI", "Paint & Film", "Memory & profiles", "Pets", "Sleep", "Operations",
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

  it("blocks saving and navigation for invalid numeric drafts, then accepts corrected values", async () => {
    mount();
    fireEvent.change(await openPrefix(), { target: { value: "changed" } });
    const number = screen.getByRole("spinbutton", { name: "Timeout" });
    fireEvent.change(number, { target: { value: "" } });
    expect(screen.getByRole("alert").textContent).toBe("Enter a number.");
    expect((screen.getByRole("button", { name: "Save changes" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Access" }));
    expect(screen.getByRole("spinbutton", { name: "Timeout" })).toBe(number);
    expect(document.activeElement).toBe(number);
    expect(api.saveConfig).not.toHaveBeenCalled();
    fireEvent.change(number, { target: { value: "15" } });
    expect(screen.queryByRole("alert")).toBeNull();
    expect((screen.getByRole("button", { name: "Save changes" }) as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Access" }));
    expect(screen.getByRole("button", { name: "Access" }).getAttribute("aria-current")).toBe("page");
  });

  it("preserves invalid numeric input when a background config refresh arrives", async () => {
    const client = mount();
    await openPrefix();
    const number = screen.getByRole("spinbutton", { name: "Timeout" }) as HTMLInputElement;
    fireEvent.change(number, { target: { value: "2" } });
    act(() => client.setQueryData(["config"], { config: { ...config, transcriptionTimeoutSeconds: 120 }, revision: "remote" }));
    expect(number.value).toBe("2");
    expect(screen.getByRole("alert").textContent).toBe("Enter at least 5.");
  });

  it("reloads and discards invalid-only drafts after confirmation", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    mount();
    await openPrefix();
    fireEvent.change(screen.getByRole("spinbutton", { name: "Timeout" }), { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "Reload" }));
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
    expect(window.confirm).toHaveBeenCalledOnce();
    expect((screen.getByRole("spinbutton", { name: "Timeout" }) as HTMLInputElement).value).toBe("90");
    fireEvent.click(screen.getByRole("button", { name: "Access" }));
    expect(screen.getByRole("button", { name: "Access" }).getAttribute("aria-current")).toBe("page");
  });

  it("keeps invalid-only drafts when discard confirmation is cancelled", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(false);
    mount();
    await openPrefix();
    const number = screen.getByRole("spinbutton", { name: "Timeout" }) as HTMLInputElement;
    fireEvent.change(number, { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "Reload" }));
    expect(api.getConfig).toHaveBeenCalledTimes(1);
    expect(number.value).toBe("");
    expect(screen.getByRole("alert")).toBeTruthy();
  });

  it("does not reset independent pet drafts when global configuration is reloaded", async () => {
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Pets" }));
    const pet = screen.getByLabelText("Pet draft") as HTMLInputElement;
    fireEvent.change(pet, { target: { value: "Unsaved pet" } });
    fireEvent.click(screen.getByRole("button", { name: "Reload" }));
    await waitFor(() => expect(api.getConfig).toHaveBeenCalledTimes(2));
    expect(screen.getByLabelText("Pet draft")).toBe(pet);
    expect(pet.value).toBe("Unsaved pet");
  });

  it("opens operations separately without fetching it on other sections", async () => {
    vi.mocked(api.getOperations).mockReturnValue(new Promise(() => {}));
    mount();
    await screen.findByRole("button", { name: "Operations" });
    expect(api.getOperations).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Operations" }));
    expect(await screen.findByRole("heading", { name: "Operations overview" })).toBeTruthy();
    expect(api.getOperations).toHaveBeenCalledOnce();
    expect((screen.getByRole("button", { name: "Save changes" }) as HTMLButtonElement).disabled).toBe(true);
  });
});