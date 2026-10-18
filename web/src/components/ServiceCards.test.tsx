import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "@/lib/api";
import { config } from "@/test/fixtures";
import { AiCard } from "./AiCard";
import { PaintCard } from "./PaintCard";
import { MemoryCard } from "./MemoryCard";

const clients: QueryClient[] = [];
afterEach(() => {
  cleanup();
  for (const client of clients.splice(0)) client.clear();
  vi.restoreAllMocks();
});
function mount(child: React.ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  clients.push(client);
  render(<QueryClientProvider client={client}>{child}</QueryClientProvider>);
}

describe("service card feedback", () => {
  it("shows model query failures, keeps the saved selection, and supports retry", async () => {
    const models = vi.spyOn(api, "getOllamaModels").mockRejectedValue(new Error("Ollama offline"));
    mount(<AiCard config={config} onChange={() => {}} />);
    expect((await screen.findByRole("alert")).textContent).toContain("Ollama offline");
    expect((screen.getByRole("combobox", { name: "Ollama model" }) as HTMLSelectElement).value).toBe(config.ollamaModel);
    expect(screen.queryByText(/No models installed/)).toBeNull();
    models.mockResolvedValue({ ok: true, models: [] });
    fireEvent.click(screen.getByRole("button", { name: "Retry models" }));
    expect(await screen.findByText(/No models installed/)).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("shows ComfyUI failures and retry separately from a successful offline response", async () => {
    const status = vi.spyOn(api, "getComfyStatus").mockRejectedValue(new Error("ComfyUI unavailable"));
    mount(<PaintCard config={config} onChange={() => {}} />);
    expect((await screen.findByRole("alert")).textContent).toContain("ComfyUI unavailable");
    status.mockResolvedValue({ reachable: true, version: "1.2" });
    fireEvent.click(screen.getByRole("button", { name: "Retry ComfyUI status" }));
    expect(await screen.findByText("Reachable — v1.2")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("does not mistake initial service checks for unreachable services", () => {
    vi.spyOn(api, "getOllamaModels").mockReturnValue(new Promise(() => {}));
    vi.spyOn(api, "getComfyStatus").mockReturnValue(new Promise(() => {}));
    mount(<><AiCard config={config} onChange={() => {}} /><PaintCard config={config} onChange={() => {}} /></>);
    expect(screen.getAllByText("Checking…")).toHaveLength(2);
    expect(screen.queryByText("Unreachable")).toBeNull();
  });

  it("uses shared labeled fields and the backend's numeric bounds for memory", () => {
    const change = vi.fn();
    mount(<MemoryCard config={config} onChange={change} />);
    expect(screen.getByRole("switch", { name: "User memory" })).toBeTruthy();
    const cases = [
      ["Messages kept / user", "5", "500"],
      ["Fallback context", "1", "100"],
      ["Rebuild every (msgs)", "1", null],
      ["Rebuild every (days)", "1", null],
      ["Deep sample size", "5", "200"],
      ["Briefing length", "100", "1000"],
    ] as const;
    for (const [label, min, max] of cases) {
      const field = screen.getByRole("spinbutton", { name: label });
      expect(field.getAttribute("min")).toBe(min);
      expect(field.getAttribute("max")).toBe(max);
    }
    fireEvent.change(screen.getByLabelText("Messages kept / user"), { target: { value: "0" } });
    expect(change).not.toHaveBeenCalled();
    expect(screen.getByRole("alert").textContent).toBe("Enter at least 5.");
  });

  it("accepts fractional paint settings but rejects fractional steps and dimensions", () => {
    vi.spyOn(api, "getComfyStatus").mockReturnValue(new Promise(() => {}));
    const change = vi.fn();
    mount(<PaintCard config={config} onChange={change} />);
    fireEvent.change(screen.getByLabelText("CFG scale"), { target: { value: "7.25" } });
    fireEvent.change(screen.getByLabelText("Denoise"), { target: { value: "0.25" } });
    fireEvent.change(screen.getByLabelText("Flux guidance"), { target: { value: "3.75" } });
    expect(change.mock.calls).toEqual([[{ paintCfgScale: 7.25 }], [{ paintDenoise: 0.25 }], [{ paintGuidance: 3.75 }]]);
    change.mockClear();
    fireEvent.change(screen.getByLabelText("Steps"), { target: { value: "2.5" } });
    fireEvent.change(screen.getByLabelText("Width"), { target: { value: "768.5" } });
    expect(screen.getAllByRole("alert")).toHaveLength(2);
    expect(change).not.toHaveBeenCalled();
  });
});
