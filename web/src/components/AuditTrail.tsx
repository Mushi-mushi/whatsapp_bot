import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, type AuditEntry } from "@/lib/api";
import { Button } from "./ui/button";
import { EmptyState, LoadingState, QueryError } from "./QueryFeedback";

const actions: Record<AuditEntry["action"], string> = {
  "reminder.create": "Create reminder", "reminder.update": "Update reminder",
  "reminder.cancel": "Cancel reminder", "tell.cancel": "Cancel tell",
  "suggestion.delete": "Delete suggestion", "delivery.retry": "Retry delivery",
  "config.save": "Save configuration", "pet.update": "Update pet", "pet.save": "Save pet settings",
  "pet.enable": "Enable/spawn pet", "pet.disable": "Disable pet", "pet.pause": "Pause pet", "pet.resume": "Resume pet",
  "pet.request": "Request pet challenge", "pet.evolve": "Evolve pet",
  "profile.refresh": "Refresh profile", "profile.forget": "Forget profile", "job.cancel": "Cancel background job",
  "usage.reset": "Reset user command usage",
  "billing.charge": "Add fake billing charge",
  "siesta.cancel": "Cancel siesta", "discipline.sleep": "Put player to sleep", "discipline.arm": "Arm player sleep",
  "discipline.wake": "Wake player", "trivia.reset": "Reset trivia", "trivia.close-month": "Close trivia month",
  "connection.pair": "Request pairing code", "connection.resync": "Resync contacts", "connection.relink": "Relink WhatsApp",
};
const outcomes: Record<AuditEntry["outcome"], string> = {
  succeeded: "Succeeded", rejected: "Rejected", failed: "Failed; changes may have occurred",
  unknown: "Outcome unknown; in progress or interrupted",
};

export function AuditTrail() {
  const [page, setPage] = useState(1);
  const query = useQuery({
    queryKey: ["audit", page], queryFn: () => api.getAudit(page), refetchInterval: 10000, retry: false,
  });
  const data = query.data;
  return <section aria-labelledby="administrative-history" className="space-y-3">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <h3 id="administrative-history" className="font-medium">Administrative audit trail</h3>
      <Button type="button" variant="outline" disabled={query.isFetching} onClick={() => void query.refetch()}>Refresh audit trail</Button>
    </div>
    <p className="text-sm">
      Administrative API requests only, since auditing was added. Shared-token authentication cannot identify individual people.
      Chat/person targets use opaque references, not raw identities. No messages, credentials, request bodies or configuration values are stored.
      Outcomes describe the server response, not confirmed message delivery or proof that a failed action had no effects.
    </p>
    {query.isPending && <LoadingState>Loading audit trail...</LoadingState>}
    {query.error && <QueryError message={`Audit trail unavailable: ${query.error.message}`}
      onRetry={() => void query.refetch()} retrying={query.isFetching} retryLabel="Retry audit trail" />}
    {data && <>
      <p className="text-xs text-muted-foreground">
        {query.error ? "Last successful audit snapshot (may be stale)" : "Snapshot"}: {new Date(data.sampledAt).toLocaleString()}
      </p>
      <p className="text-sm">{data.total} retained entries · Page {page} · Retention: {data.retentionDays} days, latest {data.maxEntries.toLocaleString()} entries.</p>
      {data.entries.length === 0 ? <EmptyState>{data.total === 0
        ? "No administrative actions recorded yet." : "No audit entries on this page. Go back or refresh."}</EmptyState>
        : <ol className="space-y-3">{data.entries.map((entry) => <li key={entry.id} className="min-w-0 rounded-md border p-3 space-y-2 text-sm">
          <h4 className="font-medium">#{entry.id} · {actions[entry.action]}</h4>
          <p>{outcomes[entry.outcome]}{entry.statusCode !== null && ` · HTTP ${entry.statusCode}`}</p>
          <p className="break-all">Target: {entry.targetId ?? "Not applicable or unavailable"}</p>
          <p>Actor: {entry.actor === "authenticated-api" ? "Authenticated API (shared token)" : "Local insecure API (authentication disabled)"}</p>
          <p>Started: <time dateTime={new Date(entry.startedAt).toISOString()}>{new Date(entry.startedAt).toLocaleString()}</time></p>
          {entry.completedAt !== null && <p>Completed: <time dateTime={new Date(entry.completedAt).toISOString()}>{new Date(entry.completedAt).toLocaleString()}</time></p>}
        </li>)}</ol>}
      <p className="text-xs text-muted-foreground">Newest recorded requests first. New entries and retention can shift pages. Times use your browser's local timezone. This is not a tamper-proof log.</p>
    </>}
    <div className="flex flex-wrap gap-2">
      <Button type="button" variant="outline" disabled={page === 1} onClick={() => setPage((value) => value - 1)}>Previous audit entries</Button>
      <Button type="button" variant="outline" disabled={!data || !!query.error || query.isFetching || page >= 1_000_000 || page * data.pageSize >= data.total}
        onClick={() => setPage((value) => value + 1)}>Next audit entries</Button>
    </div>
  </section>;
}
