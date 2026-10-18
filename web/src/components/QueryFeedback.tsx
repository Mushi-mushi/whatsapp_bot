import type { ReactNode } from "react";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";

export function LoadingState({ children }: { children: ReactNode }) {
  return <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground">
    <Loader2 aria-hidden="true" className="h-4 w-4 animate-spin" /> {children}
  </p>;
}

export function QueryError({ message, onRetry, retrying, retryLabel = "Retry" }: {
  message: string;
  onRetry: () => void;
  retrying?: boolean;
  retryLabel?: string;
}) {
  return <div className="space-y-2">
    <p role="alert" className="text-sm text-destructive">{message}</p>
    <Button type="button" variant="outline" size="sm" onClick={onRetry} disabled={retrying}>
      {retrying && <Loader2 aria-hidden="true" className="h-4 w-4 animate-spin" />}
      {retryLabel}
    </Button>
  </div>;
}

export function EmptyState({ children }: { children: ReactNode }) {
  return <p className="text-sm text-muted-foreground">{children}</p>;
}
