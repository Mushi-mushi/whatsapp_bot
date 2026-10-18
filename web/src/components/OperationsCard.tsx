import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { EmptyState, LoadingState, QueryError } from "@/components/QueryFeedback";
import { RotateCw } from "lucide-react";

function timestamp(value: number | null): string {
  return value === null ? "Unknown (before monitoring was added)" : new Date(value).toLocaleString();
}

function duration(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor(seconds % 3600 / 60);
  return `${hours}h ${minutes}m ${seconds % 60}s`;
}

export function OperationsCard() {
  const query = useQuery({
    queryKey: ["operations"], queryFn: api.getOperations, refetchInterval: 5000, retry: false,
  });
  const data = query.data;
  return <Card>
    <CardHeader className="gap-3">
      <div className="flex items-center justify-between gap-3">
        <CardTitle>Operations overview</CardTitle>
        <Button type="button" variant="outline" size="sm" disabled={query.isFetching}
          onClick={() => void query.refetch()}>
          <RotateCw aria-hidden="true" className={`h-4 w-4${query.isFetching ? " animate-spin" : ""}`} /> Refresh operations
        </Button>
      </div>
      <CardDescription>
        Read-only queue and delivery monitoring. Refreshes every 5 seconds while this section is open.
        Message contents, identities and raw errors are not included.
      </CardDescription>
    </CardHeader>
    <CardContent className="space-y-6">
      {query.isPending && <LoadingState>Loading operations...</LoadingState>}
      {query.error && <QueryError message={`Operations unavailable: ${query.error.message}`}
        onRetry={() => void query.refetch()} retrying={query.isFetching} retryLabel="Retry operations" />}
      {data && <>
        <div className="text-sm text-muted-foreground">
          <p>{query.error ? "Last successful snapshot (may be stale)" : "Snapshot"}: {timestamp(data.sampledAt)}</p>
          <p>Process uptime: {duration(data.sampledAt - data.startedAt)}</p>
          <p>{data.deliveryReady ? "Delivery transport connected" : "Delivery transport disconnected — queued deliveries wait for reconnection."}</p>
        </div>
        <section aria-labelledby="operations-backups" className="space-y-3">
          <h3 id="operations-backups" className="font-medium">Database backups</h3>
          <p className="text-sm">{data.backups.enabled
            ? `Enabled: startup and every ${data.backups.intervalHours} hours; ${data.backups.retentionDays}-day automated backup retention.`
            : "Automatic backups disabled. Configure BACKUP_DIR on the server to enable them."}</p>
          {data.backups.running && <p role="status" className="text-sm">Database backup in progress...</p>}
          {data.backups.lastError && <p role="alert" className="text-sm text-destructive">
            {data.backups.lastError === "prune" ? "Backup retention cleanup failed" : "Database backup failed"}
            {data.backups.lastFailureAt !== null && ` at ${timestamp(data.backups.lastFailureAt)}`}. See server logs; the next scheduled pass will retry.
          </p>}
          <p className="text-sm">{data.backups.lastSuccessAt === null
            ? "No verified database backup recorded."
            : `Last verified backup: ${timestamp(data.backups.lastSuccessAt)} (${duration(data.sampledAt - data.backups.lastSuccessAt)} ago).`}</p>
          {data.backups.lastSizeBytes !== null && <p className="text-sm">Last verified backup size: {data.backups.lastSizeBytes.toLocaleString()} bytes</p>}
          {data.backups.nextRunAt !== null && <p className="text-sm">Next scheduled backup: {timestamp(data.backups.nextRunAt)}</p>}
          <p className="text-xs text-muted-foreground">
            SQLite integrity and foreign keys are checked before publishing each standalone backup.
            Status survives restarts and records verification time, not continued file availability.
            Only automated backup files are pruned, after a new verified backup.
            WhatsApp authentication is not included. Protect backups as sensitive data.
          </p>
        </section>
        <section aria-labelledby="operations-jobs" className="space-y-3">
          <h3 id="operations-jobs" className="font-medium">Background jobs</h3>
          <p className="text-sm">{data.jobs.accepting ? "Accepting work" : "Draining for shutdown"} · Capacity {data.jobs.capacity} (running + queued)</p>
          <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Metric label="Running jobs" value={data.jobs.running ? 1 : 0} />
            <Metric label="Queued jobs" value={data.jobs.queued} />
            <Metric label="Completed jobs" value={data.jobs.completed} />
            <Metric label="Failed jobs" value={data.jobs.failed} />
          </dl>
          {data.jobs.running && <p className="text-sm">
            Running {data.jobs.running.kind === "profile" ? "profile refresh" : "command"} ·
            {" "}{duration(data.sampledAt - data.jobs.running.startedAt)} elapsed
          </p>}
          {data.jobs.oldestQueuedAt !== null && <p className="text-sm">
            Oldest queued job waiting {duration(data.sampledAt - data.jobs.oldestQueuedAt)}
          </p>}
          <p className="text-sm text-muted-foreground">
            Rejected submissions: queue full {data.jobs.rejected.capacity} · duplicate/per-chat limit {data.jobs.rejected.duplicate} · shutting down {data.jobs.rejected.stopping}
          </p>
          <p className="text-xs text-muted-foreground">
            Job counters and the latest 20 execution failures reset on process restart. Completed means the handler returned;
            handled AI/service errors may still be reported to the user or server logs.
          </p>
          <h4 className="text-sm font-medium">Recent background execution failures</h4>
          {data.jobs.recentFailures.length === 0 ? <EmptyState>No background execution failures recorded this process.</EmptyState>
            : <ul className="space-y-2">{data.jobs.recentFailures.map((failure) => <li key={failure.id} className="rounded-md border p-3 text-sm">
              {failure.kind === "profile" ? "Profile refresh" : "Command"} failed at {timestamp(failure.failedAt)}
              {" · "}{duration(failure.failedAt - failure.startedAt)} running · See server logs for diagnostic details.
            </li>)}</ul>}
        </section>
        <section aria-labelledby="operations-deliveries" className="space-y-3">
          <h3 id="operations-deliveries" className="font-medium">Durable deliveries</h3>
          <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Metric label="Pending deliveries" value={data.outbox.counts.pending} />
            <Metric label="Sending deliveries" value={data.outbox.counts.sending} />
            <Metric label="Failed deliveries" value={data.outbox.counts.failed} />
            <Metric label="Sent deliveries" value={data.outbox.counts.sent} />
            <Metric label="Cancelled deliveries" value={data.outbox.counts.cancelled} />
            <Metric label="Ready deliveries" value={data.outbox.ready} />
            <Metric label="Retrying deliveries" value={data.outbox.retrying} />
            <Metric label="Expired leases" value={data.outbox.expiredLeases} />
          </dl>
          <p className="text-sm">{data.outbox.nextAttemptAt === null ? "No delivery attempt scheduled."
            : `Next attempt eligible at ${timestamp(data.outbox.nextAttemptAt)} (or now if overdue); connection and pet state may defer it.`}</p>
          <p className="text-xs text-muted-foreground">
            Counts cover retained outbox rows, not all outgoing WhatsApp replies. Ready and retrying are subsets of pending.
            Expired leases recover on the next connected worker pass. Failed deliveries have exhausted 5 attempts.
          </p>
          <h4 className="text-sm font-medium">Recent unresolved delivery failures</h4>
          {data.outbox.recentFailures.length === 0 ? <EmptyState>No unresolved delivery failures.</EmptyState>
            : <ul className="space-y-2">{data.outbox.recentFailures.map((failure) => <li key={failure.id} className="rounded-md border p-3 text-sm">
              <p>Delivery #{failure.id} · {failure.status} · {failure.attempts}/5 attempts</p>
              <p>Last failure: {timestamp(failure.failedAt)}</p>
              <p>{failure.retryAt === null ? "No automatic retry remaining."
                : `${failure.status === "sending" ? "Lease expires" : "Retry eligible"} at ${timestamp(failure.retryAt)}`}</p>
              <p className="text-muted-foreground">See server logs using the delivery ID for diagnostic details.</p>
            </li>)}</ul>}
          <p className="text-xs text-muted-foreground">Latest 20 unresolved rows, one per delivery; successful retries and cancellations leave this list. Delivery state survives restarts.</p>
        </section>
      </>}
    </CardContent>
  </Card>;
}

function Metric({ label, value }: { label: string; value: number }) {
  return <div className="rounded-md border p-3">
    <dt className="text-xs text-muted-foreground">{label}</dt>
    <dd className="text-xl font-semibold">{value}</dd>
  </div>;
}
