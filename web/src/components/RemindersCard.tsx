import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "./ui/card";
import { Button } from "./ui/button";
import { EmptyState, LoadingState, QueryError } from "./QueryFeedback";

export function RemindersCard() {
  const [page, setPage] = useState(1);
  const [notice, setNotice] = useState("");
  const client = useQueryClient();
  const query = useQuery({
    queryKey: ["reminders", page], queryFn: () => api.getReminders(page),
    refetchInterval: 10000, retry: false,
  });
  const cancel = useMutation({
    mutationFn: (id: number) => api.cancelReminder(id),
    onMutate: async () => {
      setNotice("");
      await client.cancelQueries({ queryKey: ["reminders"] });
    },
    onSuccess: (result) => {
      setNotice(`Reminder #${result.cancelledId} cancelled before delivery.`);
      client.setQueriesData<Awaited<ReturnType<typeof api.getReminders>>>({ queryKey: ["reminders"] }, (current) =>
        current?.reminders.some((r) => r.id === result.cancelledId)
          ? { ...current, reminders: current.reminders.filter((r) => r.id !== result.cancelledId), total: Math.max(0, current.total - 1) }
          : current);
    },
    onSettled: () => client.invalidateQueries({ queryKey: ["reminders"] }),
  });
  const data = query.data;
  const busy = cancel.isPending;
  return <Card>
    <CardHeader>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <CardTitle>Scheduled reminders</CardTitle>
        <Button type="button" variant="outline" disabled={query.isFetching || busy} onClick={() => void query.refetch()}>
          Refresh reminders
        </Button>
      </div>
      <CardDescription>
        View and cancel reminders still waiting in the scheduler. Refreshes every 10 seconds.
        Once handed to delivery, reminders leave this list and cannot be cancelled here.
        Create reminders in WhatsApp with bot.remind.
      </CardDescription>
    </CardHeader>
    <CardContent className="space-y-4">
      {query.isPending && <LoadingState>Loading reminders...</LoadingState>}
      {query.error && <QueryError message={`Reminders unavailable: ${query.error.message}`}
        onRetry={() => void query.refetch()} retrying={query.isFetching || busy} retryLabel="Retry reminders" />}
      {cancel.error && <p role="alert" className="text-sm text-destructive">Could not cancel reminder: {cancel.error.message}</p>}
      {notice && <p role="status" className="text-sm">{notice}</p>}
      {data && <>
        <p className="text-xs text-muted-foreground">
          {query.error ? "Last successful reminder snapshot (may be stale)" : "Snapshot"}: {new Date(data.sampledAt).toLocaleString()}
        </p>
        <p className="text-sm">{data.total} scheduled reminder{data.total === 1 ? "" : "s"} · Page {page}</p>
        {data.reminders.length === 0
          ? <EmptyState>{data.total === 0 ? "No scheduled reminders." : "No reminders on this page. Go back or refresh the list."}</EmptyState>
          : <ul className="space-y-3">{data.reminders.map((reminder) => <li key={reminder.id} className="min-w-0 rounded-md border p-3 space-y-2">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0 text-sm">
                <h3 className="font-medium break-words">{reminder.chatName || "Unknown chat"}</h3>
                <p className="break-all text-xs text-muted-foreground">{reminder.chatId}</p>
                <p>Recipient: {reminder.targetName || "Chat (no named recipient)"}</p>
                <p>Due: <time dateTime={new Date(reminder.dueAt).toISOString()}>{new Date(reminder.dueAt).toLocaleString()}</time></p>
                <p className="text-xs text-muted-foreground">{reminder.dueAt <= data.sampledAt
                  ? "Due now or overdue; awaiting handoff to delivery." : "Scheduled; not yet queued for delivery."}</p>
              </div>
              <Button type="button" variant="outline" disabled={busy || !!query.error}
                aria-label={`Cancel reminder ${reminder.id}`}
                onClick={() => {
                  if (window.confirm(`Cancel reminder #${reminder.id}? This cannot be undone. If already queued, it cannot be cancelled here.`)) {
                    cancel.mutate(reminder.id);
                  }
                }}>
                {busy && cancel.variables === reminder.id ? "Cancelling..." : "Cancel reminder"}
              </Button>
            </div>
            <p className="whitespace-pre-wrap break-words text-sm">{reminder.text}</p>
          </li>)}</ul>}
        <p className="text-xs text-muted-foreground">Times use your browser's local timezone. Queued delivery counts are available in Operations, not individual reminder delivery history.</p>
      </>}
      <div className="flex flex-wrap gap-2">
        <Button type="button" variant="outline" disabled={page === 1 || busy} onClick={() => setPage((value) => value - 1)}>Previous reminders</Button>
        <Button type="button" variant="outline" disabled={!data || !!query.error || query.isFetching || page * data.pageSize >= data.total || page >= 1_000_000 || busy}
          onClick={() => setPage((value) => value + 1)}>Next reminders</Button>
      </div>
    </CardContent>
  </Card>;
}
