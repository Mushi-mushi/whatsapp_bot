import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EvolutionTimer, PetsCard } from "./PetsCard";
import { api, type GroupPet, type PetsResponse } from "@/lib/api";

vi.mock("@/lib/api", () => ({ api: { getPets: vi.fn(), updatePet: vi.fn(), requestPet: vi.fn(), evolvePet: vi.fn() } }));
const settings = {
  wakeStart: 8, wakeEnd: 22, firstRequestMinutes: 15, requestMinHours: 8,
  requestMaxHours: 12, maxRequestsPerDay: 3, activityWindowHours: 6,
  responseMinutes: 30, silenceMinutes: 2,
};
const data: PetsResponse = {
  defaults: settings,
  groups: [{ id: "pets@g.us", name: "Pet Club", pet: null, revision: "first" }],
  species: { fox: { name: "Ember Fox", forms: ["Ember Egg", "Ember Kit"], emoji: ["egg", "fox"] } },
};
const pet: GroupPet = {
  name: "Fluffy", species: "fox", settings, enabled: true, paused: false, stage: 0,
  hunger: 100, hydration: 100, cleanliness: 100, happiness: 100, energy: 100, healthyDays: 0, hibernating: false,
  status: "", nextRequestActiveMinutes: 15, request: null,
  evolution: { nextForm: "Ember Kit", remainingHealthyMs: 86400000, sampledAt: Date.now(), running: true, frozenReason: null, canForce: true },
};
const clients: QueryClient[] = [];
afterEach(() => { cleanup(); clients.splice(0).forEach((c) => c.clear()); vi.resetAllMocks(); vi.restoreAllMocks(); vi.useRealTimers(); });
function mount(response = data) {
  vi.mocked(api.getPets).mockResolvedValue(response);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  clients.push(client);
  render(<QueryClientProvider client={client}><PetsCard /></QueryClientProvider>);
  return client;
}
describe("group pet editor", () => {
  it("confirms evolution, updates live form and preserves unsaved settings", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    vi.mocked(api.evolvePet).mockResolvedValue({
      pet: { ...pet, stage: 1, healthyDays: 1,
        evolution: { ...pet.evolution, nextForm: "Spark Fox", remainingHealthyMs: 6 * 86400000 } },
      revision: "first",
    });
    mount({ ...data, groups: [{ ...data.groups[0], pet }] });
    fireEvent.change(await screen.findByLabelText("Pet name"), { target: { value: "Unsaved name" } });
    fireEvent.click(screen.getByRole("button", { name: "Evolve now" }));
    expect((await screen.findByRole("status")).textContent).toContain("Pet evolved");
    expect(api.evolvePet).toHaveBeenCalledWith("pets@g.us", 0);
    expect(api.updatePet).not.toHaveBeenCalled();
    expect(screen.getByText(/Fluffy — Ember Kit/)).toBeTruthy();
    expect((screen.getByLabelText("Pet name") as HTMLInputElement).value).toBe("Unsaved name");
  });
  it("does not evolve when confirmation is cancelled", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(false);
    mount({ ...data, groups: [{ ...data.groups[0], pet }] });
    fireEvent.click(await screen.findByRole("button", { name: "Evolve now" }));
    expect(api.evolvePet).not.toHaveBeenCalled();
  });
  it("surfaces evolution failure without claiming success", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    vi.mocked(api.evolvePet).mockRejectedValue(new Error("Pet is offline"));
    mount({ ...data, groups: [{ ...data.groups[0], pet }] });
    fireEvent.click(await screen.findByRole("button", { name: "Evolve now" }));
    expect((await screen.findByRole("alert")).textContent).toContain("offline");
    expect(screen.queryByText(/Pet evolved/)).toBeNull();
  });
  it("updates countdown status from refreshed data without replacing editor drafts", async () => {
    const client = mount({ ...data, groups: [{ ...data.groups[0], pet }] });
    fireEvent.change(await screen.findByLabelText("Pet name"), { target: { value: "Keep me" } });
    act(() => client.setQueryData(["pets"], {
      ...data, groups: [{ ...data.groups[0], pet: { ...pet,
        evolution: { ...pet.evolution, remainingHealthyMs: 3600000, running: false, frozenReason: "Pet is paused.", canForce: false },
      } }],
    }));
    await waitFor(() => expect(screen.getByLabelText("Evolution countdown").textContent).toBe("0d 1h 0m 0s"));
    expect((screen.getByLabelText("Pet name") as HTMLInputElement).value).toBe("Keep me");
    expect((screen.getByRole("button", { name: "Evolve now" }) as HTMLButtonElement).disabled).toBe(true);
  });
  it.each(["feed", "water", "clean", "play", "silence"] as const)("lets an egg issue the selected %s request", async (kind) => {
    vi.mocked(api.requestPet).mockResolvedValue({ pet: { ...pet, request: { kind, delivered: false } }, revision: "first" });
    mount({ ...data, groups: [{ ...data.groups[0], pet }] });
    fireEvent.change(await screen.findByLabelText("Request type"), { target: { value: kind } });
    fireEvent.click(screen.getByRole("button", { name: "Request now" }));
    await screen.findByRole("status");
    expect(api.requestPet).toHaveBeenCalledWith("pets@g.us", kind);
    expect(api.updatePet).not.toHaveBeenCalled();
  });

  describe("evolution countdown", () => {
    it("ticks by second and holds when frozen", () => {
      vi.useFakeTimers();
      const evolution = { ...pet.evolution, sampledAt: Date.now(), remainingHealthyMs: 65000 };
      const { rerender } = render(<EvolutionTimer evolution={evolution} />);
      expect(screen.getByLabelText("Evolution countdown").textContent).toBe("0d 0h 1m 5s");
      act(() => { vi.advanceTimersByTime(2000); });
      expect(screen.getByLabelText("Evolution countdown").textContent).toBe("0d 0h 1m 3s");
      rerender(<EvolutionTimer evolution={{ ...evolution, running: false, frozenReason: "Pet is hibernating." }} />);
      act(() => { vi.advanceTimersByTime(5000); });
      expect(screen.getByLabelText("Evolution countdown").textContent).toBe("0d 0h 1m 5s");
      expect(screen.getByText(/Frozen: Pet is hibernating/)).toBeTruthy();
    });
    it("does not keep counting down indefinitely when fresh status is unavailable", () => {
      vi.useFakeTimers();
      render(<EvolutionTimer evolution={{ ...pet.evolution, sampledAt: Date.now(), remainingHealthyMs: 65000 }} />);
      act(() => { vi.advanceTimersByTime(60000); });
      expect(screen.getByLabelText("Evolution countdown").textContent).toBe("0d 0h 0m 50s");
      expect(screen.getByText(/Waiting for fresh pet status/)).toBeTruthy();
    });
    it("shows final form without a countdown", () => {
      render(<EvolutionTimer evolution={{ ...pet.evolution, nextForm: null, running: false, canForce: false }} />);
      expect(screen.getByText("Final form unlocked!")).toBeTruthy();
      expect(screen.queryByLabelText("Evolution countdown")).toBeNull();
    });
  });
  it("queues a manual request without saving or discarding edited settings", async () => {
    vi.mocked(api.requestPet).mockResolvedValue({ pet: { ...pet, request: { kind: "feed", delivered: false } }, revision: "first" });
    mount({ ...data, groups: [{ ...data.groups[0], pet }] });
    fireEvent.change(await screen.findByLabelText("Pet name"), { target: { value: "Unsaved name" } });
    fireEvent.click(screen.getByRole("button", { name: "Request now" }));
    expect((await screen.findByRole("status")).textContent).toContain("queued for WhatsApp");
    expect(api.requestPet).toHaveBeenCalledWith("pets@g.us", "random");
    expect(api.updatePet).not.toHaveBeenCalled();
    expect((screen.getByLabelText("Pet name") as HTMLInputElement).value).toBe("Unsaved name");
    expect((screen.getByRole("button", { name: "Request now" }) as HTMLButtonElement).disabled).toBe(true);
  });
  it("shows manual request failures without claiming it was sent", async () => {
    vi.mocked(api.requestPet).mockRejectedValue(new Error("Pet is offline"));
    mount({ ...data, groups: [{ ...data.groups[0], pet }] });
    fireEvent.click(await screen.findByRole("button", { name: "Request now" }));
    expect((await screen.findByRole("alert")).textContent).toContain("offline");
    expect(screen.queryByText(/Request queued/)).toBeNull();
  });
  it("spawns a named pet with a chosen species and per-group settings", async () => {
    vi.mocked(api.updatePet).mockResolvedValue({ pet, revision: "second" });
    mount();
    fireEvent.change(await screen.findByLabelText("Pet name"), { target: { value: "Fluffy" } });
    fireEvent.change(screen.getByLabelText("Species"), { target: { value: "fox" } });
    fireEvent.change(screen.getByLabelText("First request delay (active minutes)"), { target: { value: "5" } });
    fireEvent.click(screen.getByRole("button", { name: "Spawn pet" }));
    await screen.findByRole("status");
    expect(api.updatePet).toHaveBeenCalledWith("pets@g.us", "first", {
      action: "enable", name: "Fluffy", species: "fox", settings: { ...settings, firstRequestMinutes: 5 },
    });
    expect((screen.getByLabelText("Species") as HTMLSelectElement).disabled).toBe(true);
    expect(screen.getByRole("button", { name: "Pause pet" })).toBeTruthy();
  });
  it("keeps edits on save failure and displays an explicit error", async () => {
    vi.mocked(api.updatePet).mockRejectedValue(new Error("Pet settings changed elsewhere"));
    mount({ ...data, groups: [{ ...data.groups[0], pet }] });
    fireEvent.change(await screen.findByLabelText("Pet name"), { target: { value: "Potato" } });
    fireEvent.click(screen.getByRole("button", { name: "Save pet settings" }));
    expect((await screen.findByRole("alert")).textContent).toContain("changed elsewhere");
    expect((screen.getByLabelText("Pet name") as HTMLInputElement).value).toBe("Potato");
  });
  it("supports zero daily requests and pause actions using the saved revision", async () => {
    vi.mocked(api.updatePet).mockResolvedValue({ pet: { ...pet, paused: true }, revision: "second" });
    mount({ ...data, groups: [{ ...data.groups[0], pet }] });
    fireEvent.change(await screen.findByLabelText("Maximum requests per UTC day (0 = off)"), { target: { value: "0" } });
    fireEvent.click(screen.getByRole("button", { name: "Pause pet" }));
    await screen.findByRole("status");
    expect(api.updatePet).toHaveBeenCalledWith("pets@g.us", "first", expect.objectContaining({
      action: "pause", settings: { ...settings, maxRequestsPerDay: 0 },
    }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Resume pet" })).toBeTruthy());
  });
  it("explains how to approve groups when no approved group exists", async () => {
    mount({ ...data, groups: [] });
    expect(await screen.findByText(/No approved groups/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Spawn pet" })).toBeNull();
  });
});
