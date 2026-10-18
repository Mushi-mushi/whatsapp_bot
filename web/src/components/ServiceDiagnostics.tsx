import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import type { ServiceDiagnostic } from "../../../shared/api.js";
import { LoadingState, QueryError } from "./QueryFeedback";
import { Button } from "./ui/button";

const names = { ollama: "Ollama", comfyui: "ComfyUI", transcription: "Transcription (Auralis)" };
const labels: Record<ServiceDiagnostic["status"], string> = {
  available: "Available", disabled: "Disabled in saved settings", unsupported: "Unsupported transcription provider",
  timeout: "Timed out", unreachable: "Unreachable", "http-error": "HTTP error",
  "invalid-response": "Unexpected response", "invalid-config": "Invalid service URL",
};

export function ServiceDiagnostics() {
  const query = useQuery({
    queryKey: ["service-diagnostics"], queryFn: api.getServiceDiagnostics, refetchInterval: 30000, retry: false,
  });
  return <section aria-labelledby="operations-services" className="space-y-3">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <h3 id="operations-services" className="font-medium">Service diagnostics</h3>
      <Button type="button" variant="outline" size="sm" disabled={query.isFetching} onClick={() => void query.refetch()}>
        Refresh service checks
      </Button>
    </div>
    <p className="text-xs text-muted-foreground">
      Lightweight availability checks, not inference tests. Three-second timeouts; server results cached for 30 seconds.
      Saved settings apply; disabled services are not contacted. Availability does not guarantee models or GPU capacity.
    </p>
    {query.isPending && <LoadingState>Checking services...</LoadingState>}
    {query.error && <QueryError message={`Service checks unavailable: ${query.error.message}`}
      onRetry={() => void query.refetch()} retrying={query.isFetching} retryLabel="Retry service checks" />}
    {query.data && <>
      <p className="text-xs text-muted-foreground">
        {query.error ? "Last successful service snapshot (may be stale)" : "Service snapshot"}: {new Date(query.data.sampledAt).toLocaleString()}
      </p>
      <ul className="grid gap-3 sm:grid-cols-3">
        {query.data.services.map((service) => <li key={service.service} className="rounded-md border p-3 text-sm">
          <h4 className="font-medium">{names[service.service]}</h4>
          <p>{labels[service.status]}{service.httpStatus !== null && ` (HTTP ${service.httpStatus})`}</p>
          <p className="text-xs text-muted-foreground">Checked: {new Date(service.checkedAt).toLocaleString()}</p>
          {service.latencyMs !== null && <p className="text-xs text-muted-foreground">Check latency: {service.latencyMs} ms</p>}
        </li>)}
      </ul>
    </>}
  </section>;
}
