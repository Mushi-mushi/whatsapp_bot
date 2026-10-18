import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FieldValidationProvider, NumberField, Row, TextAreaField, TextField, useFieldErrors } from "./fields";
import { Switch } from "./ui/switch";

afterEach(cleanup);

describe("shared fields", () => {
  it("associates text, password and textarea labels and hints with their controls", () => {
    render(<>
      <TextField label="URL" hint="Service base URL" value="" onChange={() => {}} />
      <TextField label="Secret" type="password" value="" onChange={() => {}} />
      <TextAreaField label="Prompt" hint="Model instructions" value="" onChange={() => {}} />
    </>);
    for (const name of ["URL", "Secret", "Prompt"]) expect(screen.getByLabelText(name)).toBeTruthy();
    for (const name of ["URL", "Prompt"]) {
      const hintId = screen.getByLabelText(name).getAttribute("aria-describedby")!;
      expect(document.getElementById(hintId)?.textContent).toBe(name === "URL" ? "Service base URL" : "Model instructions");
    }
  });

  it("labels switches and makes the label clickable", () => {
    const change = vi.fn();
    render(<Row label="Learn from messages" hint="Per chat"><Switch checked={false} onCheckedChange={change} /></Row>);
    const control = screen.getByRole("switch", { name: "Learn from messages" });
    expect(document.getElementById(control.getAttribute("aria-describedby")!)?.textContent).toBe("Per chat");
    fireEvent.click(screen.getByText("Learn from messages"));
    expect(change).toHaveBeenCalledWith(true);
  });

  it("preserves zero and accepts fractional values when allowed", () => {
    const change = vi.fn();
    render(<NumberField label="Amount" value={1} min={0} max={10} step="any" onChange={change} />);
    const input = screen.getByRole("spinbutton", { name: "Amount" });
    fireEvent.change(input, { target: { value: "0" } });
    fireEvent.change(input, { target: { value: "0.25" } });
    expect(change.mock.calls).toEqual([[0], [0.25]]);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it.each([
    ["", "Enter a number."],
    ["0", "Enter at least 1."],
    ["11", "Enter no more than 10."],
    ["1.5", "Enter a whole number."],
  ])("keeps invalid draft %j visible without publishing a default", (value, message) => {
    const change = vi.fn();
    render(<NumberField label="Amount" hint="Choose carefully" value={5} min={1} max={10} onChange={change} />);
    const input = screen.getByRole("spinbutton", { name: "Amount" }) as HTMLInputElement;
    fireEvent.change(input, { target: { value } });
    expect(input.value).toBe(value);
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(screen.getByRole("alert").textContent).toBe(message);
    expect(input.getAttribute("aria-describedby")).toContain(screen.getByRole("alert").id);
    expect(change).not.toHaveBeenCalled();
    fireEvent.change(input, { target: { value: "6" } });
    expect(change).toHaveBeenCalledWith(6);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("resynchronizes when the parent supplies a different value", () => {
    const { rerender } = render(<NumberField label="Amount" value={5} min={1} onChange={() => {}} />);
    fireEvent.change(screen.getByLabelText("Amount"), { target: { value: "" } });
    rerender(<NumberField label="Amount" value={8} min={1} onChange={() => {}} />);
    expect((screen.getByLabelText("Amount") as HTMLInputElement).value).toBe("8");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("cleans up registered errors when a field unmounts", () => {
    function Summary() { return <output>{Object.values(useFieldErrors()).join(",")}</output>; }
    function Form({ show }: { show: boolean }) {
      return <FieldValidationProvider><Summary />{show && <NumberField label="Amount" value={5} min={1} onChange={() => {}} />}</FieldValidationProvider>;
    }
    const { rerender } = render(<Form show />);
    fireEvent.change(screen.getByLabelText("Amount"), { target: { value: "" } });
    expect(screen.getByRole("status").textContent).toBe("Amount");
    rerender(<Form show={false} />);
    expect(screen.getByRole("status").textContent).toBe("");
  });
});
