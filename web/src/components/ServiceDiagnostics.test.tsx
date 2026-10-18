import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, type ServiceDiagnosticsResponse } from "@/lib/api";
import { ServiceDiagnostics } from "./ServiceDiagnostics";

const sample: ServiceDiagnosticsResponse = {
  sampledAt: 1700000000000, cacheSeconds: 30,
  services: [
    { service: "ollama", status: "available", checkedAt: 1700000000000, latencyMs: 15, httpStatus: 200 },
    { service: "comfyui", status: "disabled", checkedAt: 1700000000000, latencyMs: null, httpStatus: null },
    { service: "transcription", status: "timeout", checkedAt: 1700000000000, latencyMs: 3000, httpStatus: null },
  ],
};
const clients: QueryClient[] = [];
beforeEach(() => { vi.spyOn(api, "getServiceDiagnostics").mockResolvedValue(sample); });
afterEach(() => {
  cleanup();
  for (const client of clients.splice(0)) client.clear();
  vi.restoreAllMocks();
  vi.useRealTimers();
});
function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  clients.push(client);
  return render(<QueryClientProvider client={client}><ServiceDiagnostics /></QueryClientProvider>);
}

describe("service diagnostics panel", () => {
  it("shows pending checks without reporting availability prematurely", () => {
    vi.mocked(api.getServiceDiagnostics).mockReturnValue(new Promise(() => {}));
    mount();
    expect(screen.getByRole("status").textContent?.trim()).toBe("Checking services...");
    expect((screen.getByRole("button", { name: "Refresh service checks" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByText("Available")).toBeNull();
  });

  it("shows per-service states, timestamps and latency without raw responses", async () => {
    mount();
    expect(await screen.findByText("Available (HTTP 200)")).toBeTruthy();
    expect(screen.getByText("Disabled in saved settings")).toBeTruthy();
    expect(screen.getByText("Timed out")).toBeTruthy();
    expect(screen.getByText("Check latency: 15 ms")).toBeTruthy();
    expect(screen.getAllByText(/^Checked:/)).toHaveLength(3);
    expect(screen.getByText(/Availability does not guarantee/)).toBeTruthy();
  });

  it.each([
    ["unsupported", "Unsupported transcription provider"],
    ["unreachable", "Unreachable"], ["http-error", "HTTP error (HTTP 503)"],
    ["invalid-response", "Unexpected response"], ["invalid-config", "Invalid service URL"],
  ] as const)("renders %s distinctly", async (status, label) => {
    vi.mocked(api.getServiceDiagnostics).mockResolvedValue({
      ...sample, services: [{ ...sample.services[2], status, httpStatus: status === "http-error" ? 503 : null }],
    });
    mount();
    expect(await screen.findByText(label)).toBeTruthy();
  });

  it("shows a failed request explicitly and retries without turning it into healthy results", async () => {
    vi.mocked(api.getServiceDiagnostics).mockRejectedValue(new Error("API unavailable"));
    mount();
    expect((await screen.findByRole("alert")).textContent).toContain("API unavailable");
    expect(screen.queryByText("Available (HTTP 200)")).toBeNull();
    vi.mocked(api.getServiceDiagnostics).mockResolvedValue(sample);
    fireEvent.click(screen.getByRole("button", { name: "Retry service checks" }));
    expect(await screen.findByText("Available (HTTP 200)")).toBeTruthy();
  });

  it("retains a clearly stale snapshot after refresh failure", async () => {
    mount();
    await screen.findByText("Available (HTTP 200)");
    vi.mocked(api.getServiceDiagnostics).mockRejectedValue(new Error("Refresh failed"));
    fireEvent.click(screen.getByRole("button", { name: "Refresh service checks" }));
    await screen.findByRole("alert");
    expect(screen.getByText(/Last successful service snapshot \(may be stale\)/)).toBeTruthy();
    expect(screen.getByText("Available (HTTP 200)")).toBeTruthy();
  });

  it("polls every 30 seconds and stops after unmount", async () => {
    vi.useFakeTimers();
    const view = mount();
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(api.getServiceDiagnostics).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(30000); });
    expect(api.getServiceDiagnostics).toHaveBeenCalledTimes(2);
    view.unmount();
    await act(async () => { await vi.advanceTimersByTimeAsync(60000); });
    expect(api.getServiceDiagnostics).toHaveBeenCalledTimes(2);
  });
});
