import * as React from "react";
import { cn } from "@/lib/utils";

type Variant = "default" | "success" | "muted" | "destructive";

const variants: Record<Variant, string> = {
  default: "bg-primary/15 text-primary",
  success: "bg-emerald-500/15 text-emerald-400",
  muted: "bg-muted text-muted-foreground",
  destructive: "bg-destructive/15 text-destructive",
};

export function Badge({
  className,
  variant = "default",
  ...props
}: React.HTMLAttributes<HTMLSpanElement> & { variant?: Variant }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-medium",
        variants[variant],
        className,
      )}
      {...props}
    />
  );
}
