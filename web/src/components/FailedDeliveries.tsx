import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type FailedDelivery, type FailedDeliveriesResponse } from "@/lib/api";
import { Button } from "./ui/button";
import { EmptyState, LoadingState, QueryError } from "./QueryFeedback";

const failureLabels = {
  timeout: "Send timed out; delivery may have completed.",
  "lease-expired": "Worker lease expired; delivery outcome is uncertain.",
  "send-error": "Send failed; see private server logs using this delivery ID.",
  unknown: "No failure category recorded.",
};
const time = (value: number | null) => value === null ? "Unknown (before monitoring)" : new Date(value).toLocaleString();

export function FailedDeliveries() {
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<number | null>(null);
  const [notice, setNotice] = useState("");
  const client = useQueryClient();
  const query = useQuery({
    queryKey: ["failed-deliveries", page], queryFn: () => api.getFailedDeliveries(page),
    refetchInterval: 10000, retry: false,
  });
  const retry = useMutation({
    mutationFn: (delivery: FailedDelivery) => api.retryDelivery(delivery.id, {
      expectedRetryCount: delivery.retryCount, acknowledgeDuplicateRisk: true,
    }),
    onMutate: async () => {
      setNotice("");
      await client.cancelQueries({ queryKey: ["failed-deliveries"] });
    },
    onSuccess: (result) => {
      setNotice(`One additional attempt scheduled for delivery #${result.retriedId}. This does not confirm delivery.`);
      client.setQueriesData<FailedDeliveriesResponse>({ queryKey: ["failed-deliveries"] }, (current) =>
        current?.deliveries.some((entry) => entry.id === result.retriedId)
          ? { ...current, deliveries: current.deliveries.filter((entry) => entry.id !== result.retriedId), total: Math.max(0, current.total - 1) }
          : current);
    },
    onSettled: () => Promise.all([
      client.invalidateQueries({ queryKey: ["failed-deliveries"] }),
      client.invalidateQueries({ queryKey: ["delivery-history"] }),
      client.invalidateQueries({ queryKey: ["operations"] }),
      client.invalidateQueries({ queryKey: ["audit"] }),
    ]),
  });
  const data = query.data;
  return <section aria-labelledby="failed-delivery-recovery" className="space-y-3">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <h3 id="failed-delivery-recovery" className="font-medium">Failed-delivery recovery</h3>
      <Button type="button" variant="outline" disabled={query.isFetching || retry.isPending}
        onClick={() => void query.refetch()}>Refresh failed deliveries</Button>
    </div>
    <p className="text-sm">
      Only exhausted, failed deliveries can be retried. Each confirmation permits one additional send attempt, not a new automatic retry cycle.
      A failure does not prove the message was not delivered: retrying can send a duplicate.
      Transport reconnection and existing pet-state safeguards still apply.
    </p>
    {query.isPending && <LoadingState>Loading failed deliveries...</LoadingState>}
    {query.error && <QueryError message={`Failed deliveries unavailable: ${query.error.message}`}
      onRetry={() => void query.refetch()} retrying={query.isFetching || retry.isPending} retryLabel="Retry failed deliveries list" />}
    {retry.error && <p role="alert" className="text-sm text-destructive">Could not retry delivery: {retry.error.message}</p>}
    {notice && <p role="status" className="text-sm">{notice}</p>}
    {data && <>
      <p className="text-xs text-muted-foreground">
        {query.error ? "Last successful failed-delivery snapshot (may be stale)" : "Snapshot"}: {time(data.sampledAt)}
      </p>
      <p className="text-sm">{data.total} failed deliveries · Page {page}</p>
      {data.deliveries.length === 0
        ? <EmptyState>{data.total === 0 ? "No exhausted deliveries to retry." : "No failed deliveries on this page. Go back or refresh."}</EmptyState>
        : <ul className="space-y-3">{data.deliveries.map((delivery) => <li key={delivery.id} className="rounded-md border p-3 space-y-2 text-sm">
          <p className="font-medium">Failed delivery #{delivery.id}</p>
          <p>{failureLabels[delivery.failureKind]}</p>
          <p>Last failure: {time(delivery.failedAt)} · Manual retries scheduled: {delivery.retryCount}</p>
          <div className="flex flex-wrap gap-2">
            <Button type="button" variant="outline" aria-expanded={selected === delivery.id}
              onClick={() => setSelected(selected === delivery.id ? null : delivery.id)}>Inspect delivery {delivery.id}</Button>
            <Button type="button" variant="outline" aria-label={`Retry delivery ${delivery.id} once`}
              disabled={retry.isPending || query.isFetching || !!query.error}
              onClick={() => {
                if (window.confirm(`Retry delivery #${delivery.id} once? The previous send may have succeeded. This can send a duplicate message. Only one additional attempt will be permitted.`)) {
                  retry.mutate(delivery);
                }
              }}>{retry.isPending && retry.variables.id === delivery.id ? "Scheduling retry..." : "Retry once"}</Button>
          </div>
        </li>)}</ul>}
    </>}
    <div className="flex flex-wrap gap-2">
      <Button type="button" variant="outline" disabled={page === 1 || retry.isPending}
        onClick={() => setPage((value) => value - 1)}>Previous failed deliveries</Button>
      <Button type="button" variant="outline"
        disabled={!data || !!query.error || query.isFetching || retry.isPending || page >= 1_000_000 || page * data.pageSize >= data.total}
        onClick={() => setPage((value) => value + 1)}>Next failed deliveries</Button>
    </div>
    {selected !== null && <div className="space-y-2">
      <Button type="button" variant="outline" onClick={() => setSelected(null)}>Close delivery history</Button>
      <DeliveryHistory id={selected} />
    </div>}
  </section>;
}

function DeliveryHistory({ id }: { id: number }) {
  const query = useQuery({
    queryKey: ["delivery-history", id], queryFn: () => api.getDeliveryHistory(id),
    refetchInterval: 10000, retry: false,
  });
  return <section aria-label={`Delivery ${id} history`} className="space-y-2 rounded-md border p-3 text-sm">
    <h4 className="font-medium">Delivery #{id} attempt history</h4>
    <p className="text-xs text-muted-foreground">
      Latest 50 recorded claims per delivery, newest first, since history monitoring was added.
      Older attempts are not reconstructed. Deferred claims do not consume a send attempt.
      Round 0 is automatic delivery; later rounds identify manual retries. No message contents, identities or raw errors are included.
    </p>
    {query.isPending && <LoadingState>Loading delivery history...</LoadingState>}
    {query.error && <QueryError message={`Delivery history unavailable: ${query.error.message}`}
      onRetry={() => void query.refetch()} retrying={query.isFetching} retryLabel="Retry delivery history" />}
    {query.data && <>
      {query.error && <p>Last successful history (may be stale).</p>}
      {query.data.attempts.length === 0 ? <EmptyState>No recorded attempts; older attempts were not captured.</EmptyState>
        : <ol className="space-y-2">{query.data.attempts.map((attempt) => <li key={attempt.id}>
          <p>Round {attempt.retryCount} · {attempt.outcome} · Started {time(attempt.startedAt)}
            {attempt.finishedAt !== null && ` · Finished ${time(attempt.finishedAt)}`}</p>
          {attempt.failureKind !== null && <p>{failureLabels[attempt.failureKind]}</p>}
        </li>)}</ol>}
    </>}
  </section>;
}
