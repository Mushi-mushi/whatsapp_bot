import { useEffect, useState, useSyncExternalStore } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { api, ApiError, getToken, subscribeToken, type Status } from "./api";

// Retry streaming after interruptions, using a status snapshot while reconnecting.
export function useStatusStream(): Status | null {
  const [status, setStatus] = useState<Status | null>(null);
  const queryClient = useQueryClient();
  const token = useSyncExternalStore(subscribeToken, getToken);

  useEffect(() => {
    const controller = new AbortController();
    setStatus(null);
    let retry: ReturnType<typeof setTimeout> | undefined;
    const connect = async () => {
      try {
        const response = await fetch("/api/events", {
          headers: token ? { Authorization: `Bearer ${token}` } : {},
          signal: controller.signal,
        });
        if (controller.signal.aborted) return;
        if (response.status === 401) {
          setStatus(null);
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
              if (!controller.signal.aborted && frame.startsWith("data: ")) setStatus(JSON.parse(frame.slice(6)) as Status);
            }
          }
        } finally {
          await reader.cancel().catch(() => {});
          reader.releaseLock();
        }
      } catch {
        if (controller.signal.aborted) return;
      }
      if (controller.signal.aborted) return;
      try {
        const snapshot = await api.getStatus(controller.signal);
        if (!controller.signal.aborted) setStatus(snapshot);
      } catch (error) {
        if (controller.signal.aborted) return;
        setStatus(null);
        if (error instanceof ApiError && error.status === 401) {
          void queryClient.invalidateQueries({ queryKey: ["config"] });
          return;
        }
      }
      if (!controller.signal.aborted) retry = setTimeout(() => void connect(), 3000);
    };
    void connect();
    return () => {
      controller.abort();
      clearTimeout(retry);
    };
  }, [queryClient, token]);

  return status;
}
