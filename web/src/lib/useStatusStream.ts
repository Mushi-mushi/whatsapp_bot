import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { getToken, type Status } from "./api";

// Live connection status via Server-Sent Events, falling back to the initial value.
export function useStatusStream(): Status | null {
  const [status, setStatus] = useState<Status | null>(null);
  const queryClient = useQueryClient();

  useEffect(() => {
    const controller = new AbortController();
    let retry: ReturnType<typeof setTimeout> | undefined;
    const connect = async () => {
      try {
        const token = getToken();
        const response = await fetch("/api/events", {
          headers: token ? { Authorization: `Bearer ${token}` } : {},
          signal: controller.signal,
        });
        if (response.status === 401) {
          void queryClient.invalidateQueries({ queryKey: ["config"] });
          return;
        }
        if (!response.ok || !response.body) throw new Error("Status stream unavailable");
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let pending = "";
        try {
          while (!controller.signal.aborted) {
            const { value, done } = await reader.read();
            if (done) break;
            pending += decoder.decode(value, { stream: true });
            let end: number;
            while ((end = pending.indexOf("\n\n")) >= 0) {
              const frame = pending.slice(0, end);
              pending = pending.slice(end + 2);
              if (frame.startsWith("data: ")) setStatus(JSON.parse(frame.slice(6)) as Status);
            }
          }
        } finally {
          await reader.cancel().catch(() => {});
          reader.releaseLock();
        }
      } catch {
        if (!controller.signal.aborted) setStatus(null);
      }
      if (!controller.signal.aborted) retry = setTimeout(() => void connect(), 3000);
    };
    void connect();
    return () => {
      controller.abort();
      clearTimeout(retry);
    };
  }, [queryClient]);

  return status;
}
