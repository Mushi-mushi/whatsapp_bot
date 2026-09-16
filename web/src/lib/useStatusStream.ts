import { useEffect, useState } from "react";
import type { Status } from "./api";

// Live connection status via Server-Sent Events, falling back to the initial value.
export function useStatusStream(): Status | null {
  const [status, setStatus] = useState<Status | null>(null);

  useEffect(() => {
    const source = new EventSource("/api/events");
    source.onmessage = (event) => {
      try {
        setStatus(JSON.parse(event.data) as Status);
      } catch {
        /* ignore malformed frame */
      }
    };
    source.onerror = () => {
      // EventSource auto-reconnects; nothing to do.
    };
    return () => source.close();
  }, []);

  return status;
}
