import { cloneElement, createContext, useContext, useEffect, useId, useLayoutEffect, useState, type Dispatch, type ReactElement, type ReactNode, type SetStateAction } from "react";
import { Input } from "@/components/ui/input";

const FieldValidation = createContext<{
  errors: Record<string, string>;
  setErrors: Dispatch<SetStateAction<Record<string, string>>>;
} | null>(null);

export function FieldValidationProvider({ children }: { children: ReactNode }) {
  const [errors, setErrors] = useState<Record<string, string>>({});
  return <FieldValidation.Provider value={{ errors, setErrors }}>{children}</FieldValidation.Provider>;
}

export function useFieldErrors(): Record<string, string> {
  return useContext(FieldValidation)?.errors ?? {};
}

export function Row({ label, hint, children }: {
  label: string; hint?: string;
  children: ReactElement<{ id?: string; "aria-describedby"?: string }>;
}) {
  const generatedId = useId();
  const id = children.props.id ?? generatedId;
  return (
    <div className="flex items-center justify-between gap-4 py-1.5">
      <div>
        <label htmlFor={id} className="text-sm font-medium">{label}</label>
        {hint && <p id={`${id}-hint`} className="text-xs text-muted-foreground">{hint}</p>}
      </div>
      {cloneElement(children, { id, "aria-describedby": hint ? `${id}-hint` : children.props["aria-describedby"] })}
    </div>
  );
}

export function TextField({
  label,
  hint,
  value,
  placeholder,
  type = "text",
  onChange,
}: {
  label: string;
  hint?: string;
  value: string;
  placeholder?: string;
  type?: "text" | "password";
  onChange: (v: string) => void;
}) {
  const id = useId();
  return (
    <div className="space-y-1 pt-2">
      <label htmlFor={id} className="text-sm font-medium">{label}</label>
      <Input id={id} aria-describedby={hint ? `${id}-hint` : undefined} type={type} value={value} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} />
      {hint && <p id={`${id}-hint`} className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

export function NumberField({
  label,
  hint,
  value,
  min,
  max,
  step = 1,
  onChange,
}: {
  label: string;
  hint?: string;
  value: number;
  min?: number;
  max?: number;
  step?: 1 | "any";
  onChange: (v: number) => void;
}) {
  const id = useId();
  const [text, setText] = useState(String(value));
  const setErrors = useContext(FieldValidation)?.setErrors;
  useEffect(() => setText(String(value)), [value]);
  const number = Number(text);
  const error = text.trim() === "" || !Number.isFinite(number) ? "Enter a number."
    : step === 1 && !Number.isInteger(number) ? "Enter a whole number."
    : min !== undefined && number < min ? `Enter at least ${min}.`
    : max !== undefined && number > max ? `Enter no more than ${max}.` : "";

  useLayoutEffect(() => {
    setErrors?.((current) => {
      if (error) return current[id] === label ? current : { ...current, [id]: label };
      if (!(id in current)) return current;
      const next = { ...current };
      delete next[id];
      return next;
    });
    return () => setErrors?.((current) => {
      if (!(id in current)) return current;
      const next = { ...current };
      delete next[id];
      return next;
    });
  }, [error, id, label, setErrors]);

  return (
    <div className="space-y-1">
      <label htmlFor={id} className="text-sm font-medium">{label}</label>
      <Input id={id} type="number" required min={min} max={max} step={step} value={text}
        aria-invalid={!!error}
        aria-describedby={[hint && `${id}-hint`, error && `${id}-error`].filter(Boolean).join(" ") || undefined}
        onChange={(event) => {
          const raw = event.target.value;
          setText(raw);
          if (raw.trim() && event.target.validity.valid && Number.isFinite(event.target.valueAsNumber)) {
            onChange(event.target.valueAsNumber);
          }
        }} />
      {hint && <p id={`${id}-hint`} className="text-xs text-muted-foreground">{hint}</p>}
      {error && <p id={`${id}-error`} role="alert" className="text-xs text-destructive">{error}</p>}
    </div>
  );
}

export function TextAreaField({
  label,
  hint,
  value,
  placeholder,
  rows = 4,
  onChange,
}: {
  label: string;
  hint?: string;
  value: string;
  placeholder?: string;
  rows?: number;
  onChange: (v: string) => void;
}) {
  const id = useId();
  return (
    <div className="space-y-1 pt-2">
      <label htmlFor={id} className="text-sm font-medium">{label}</label>
      <textarea
        id={id}
        aria-describedby={hint ? `${id}-hint` : undefined}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        rows={rows}
        placeholder={placeholder}
        className="w-full resize-y rounded-md border border-input bg-background px-3 py-2 text-sm"
      />
      {hint && <p id={`${id}-hint`} className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}
