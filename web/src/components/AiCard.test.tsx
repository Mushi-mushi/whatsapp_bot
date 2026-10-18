import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, expect, it, vi } from "vitest";
import { AiCard } from "./AiCard";
import { FieldValidationProvider } from "./fields";
import { api } from "@/lib/api";
import { config } from "@/test/fixtures";

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

it("edits the ask allowance without publishing invalid counts", () => {
  vi.spyOn(api, "getOllamaModels").mockResolvedValue({ ok: true, models: ["test-model"] });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const change = vi.fn();
  try {
    render(<QueryClientProvider client={client}><FieldValidationProvider>
      <AiCard config={config} onChange={change} />
    </FieldValidationProvider></QueryClientProvider>);
    const field = screen.getByRole("spinbutton", { name: "Maximum bot.ask calls" });
    expect((field as HTMLInputElement).value).toBe("10");
    fireEvent.change(field, { target: { value: "25" } });
    expect(change).toHaveBeenLastCalledWith({ askMaxCalls: 25 });
    change.mockClear();
    for (const value of ["0", "1.5", ""]) {
      fireEvent.change(field, { target: { value } });
      expect(screen.getByRole("alert")).toBeTruthy();
      expect(change).not.toHaveBeenCalled();
    }
  } finally { cleanup(); client.clear(); }
});
