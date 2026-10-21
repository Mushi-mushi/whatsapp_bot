import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, type BillingCustomer } from "@/lib/api";
import { BillingCard } from "./BillingCard";

const initial: BillingCustomer = {
  senderId: "34600000002@s.whatsapp.net",
  name: "Si Ying",
  phone: "34600000002",
  debtCents: 0,
  interactionCount: 0,
  muteAllowanceMinutes: 0,
};

const clients: QueryClient[] = [];
beforeEach(() => {
  vi.spyOn(api, "getBilling").mockResolvedValue({ customers: [initial], sampledAt: Date.now() });
});
afterEach(() => {
  cleanup();
  for (const client of clients.splice(0)) client.clear();
  vi.restoreAllMocks();
});

function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  clients.push(client);
  render(<QueryClientProvider client={client}><BillingCard /></QueryClientProvider>);
}

describe("billing adjustments", () => {
  it("adds a fake EUR charge and refreshes debt and mute allowance", async () => {
    const updated = { ...initial, debtCents: 144_000, muteAllowanceMinutes: 1440 };
    const add = vi.spyOn(api, "addBillingCharge").mockResolvedValue({ ok: true, customer: updated });
    mount();

    await screen.findByText(/Outstanding fake debt:/);
    fireEvent.change(screen.getByLabelText("Charge (EUR)"), { target: { value: "1440.00" } });
    fireEvent.click(screen.getByRole("button", { name: "Add charge" }));

    await waitFor(() => expect(add).toHaveBeenCalledWith({ senderId: initial.senderId, amountCents: 144_000 }));
    expect((await screen.findByRole("status")).textContent).toContain("Added €1,440.00 to Si Ying's fake bill.");
    expect(await screen.findByText(/1,440 min/)).toBeTruthy();
  });

  it("blocks amounts outside the supported range", async () => {
    const add = vi.spyOn(api, "addBillingCharge");
    mount();
    await screen.findByText(/Outstanding fake debt:/);
    const amount = screen.getByLabelText("Charge (EUR)");
    fireEvent.change(amount, { target: { value: "10000.01" } });
    expect((screen.getByRole("button", { name: "Add charge" }) as HTMLButtonElement).disabled).toBe(true);
    expect(amount.getAttribute("aria-invalid")).toBe("true");
    expect(add).not.toHaveBeenCalled();
  });
});