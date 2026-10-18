import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GeneralCard } from "./GeneralCard";
import { config } from "@/test/fixtures";
import { FieldValidationProvider } from "./fields";

afterEach(cleanup);

describe("retention controls", () => {
  it("shows saved policy and publishes edits through the global configuration workflow", () => {
    const change = vi.fn();
    render(<FieldValidationProvider><GeneralCard config={config} onChange={change} /></FieldValidationProvider>);
    expect((screen.getByRole("spinbutton", { name: "Analytics retention (days)" }) as HTMLInputElement).value).toBe("90");
    expect((screen.getByRole("spinbutton", { name: "Delivery retention (days)" }) as HTMLInputElement).value).toBe("30");
    fireEvent.click(screen.getByRole("switch", { name: "Automatic cleanup" }));
    expect(change).toHaveBeenLastCalledWith({ retentionEnabled: false });
    fireEvent.change(screen.getByRole("spinbutton", { name: "Analytics retention (days)" }), { target: { value: "180" } });
    expect(change).toHaveBeenLastCalledWith({ analyticsRetentionDays: 180 });
    fireEvent.change(screen.getByRole("spinbutton", { name: "Delivery retention (days)" }), { target: { value: "60" } });
    expect(change).toHaveBeenLastCalledWith({ deliveryRetentionDays: 60 });
    expect(screen.getByText(/Age since queued/)).toBeTruthy();
  });

  it.each(["", "0", "1.5", "3651"])("keeps invalid retention draft %s without publishing a fallback", (value) => {
    const change = vi.fn();
    render(<FieldValidationProvider><GeneralCard config={config} onChange={change} /></FieldValidationProvider>);
    fireEvent.change(screen.getByRole("spinbutton", { name: "Analytics retention (days)" }), { target: { value } });
    expect(screen.getByRole("alert")).toBeTruthy();
    expect(change).not.toHaveBeenCalled();
  });
});
