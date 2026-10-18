import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type PendingTell, type ScheduledReminder } from "@/lib/api";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "./ui/card";
import { Button } from "./ui/button";
import { EmptyState, LoadingState, QueryError } from "./QueryFeedback";

interface WaitingPage {
  entries: (ScheduledReminder | PendingTell)[];
  total: number;
  page: number;
  pageSize: number;
  sampledAt: number;
}

export function ScheduledMessagesCard({ kind }: { kind: "reminders" | "tells" }) {
  const reminderMode = kind === "reminders";
  const singular = reminderMode ? "reminder" : "tell";
  const title = reminderMode ? "Reminder" : "Tell";
  const [page, setPage] = useState(1);
  const [notice, setNotice] = useState("");
  const client = useQueryClient();
  const query = useQuery({
    queryKey: [kind, page], queryFn: async (): Promise<WaitingPage> => {
      if (reminderMode) {
        const result = await api.getReminders(page);
        return { ...result, entries: result.reminders };
      }
      const result = await api.getTells(page);
      return { ...result, entries: result.tells };
    },
    refetchInterval: 10000, retry: false,
  });
  const cancel = useMutation({
    mutationFn: (id: number) => reminderMode ? api.cancelReminder(id) : api.cancelTell(id),
    onMutate: async () => {
      setNotice("");
      await client.cancelQueries({ queryKey: [kind] });
    },
    onSuccess: (result) => {
      setNotice(`${title} #${result.cancelledId} cancelled before delivery.`);
      client.setQueriesData<WaitingPage>({ queryKey: [kind] }, (current) =>
        current?.entries.some((r) => r.id === result.cancelledId)
          ? { ...current, entries: current.entries.filter((r) => r.id !== result.cancelledId), total: Math.max(0, current.total - 1) }
          : current);
    },
    onSettled: () => client.invalidateQueries({ queryKey: [kind] }),
  });
  const data = query.data;
  const busy = cancel.isPending;
  return <Card>
    <CardHeader>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <CardTitle>{reminderMode ? "Scheduled reminders" : "Pending tells"}</CardTitle>
        <Button type="button" variant="outline" disabled={query.isFetching || busy} onClick={() => void query.refetch()}>
          Refresh {kind}
        </Button>
      </div>
      <CardDescription>
        {reminderMode ? "View and cancel reminders still waiting in the scheduler." : "New tells are bound to a person in one chat. Legacy name-only tells are held and will not be delivered automatically; they can still be cancelled here."}
        {" "}Refreshes every 10 seconds.
        Once handed to delivery, {kind} leave this list and cannot be cancelled here.
        Create {kind} in WhatsApp with {reminderMode ? "bot.remind" : "bot.tell"}.
      </CardDescription>
    </CardHeader>
    <CardContent className="space-y-4">
      {query.isPending && <LoadingState>Loading {kind}...</LoadingState>}
      {query.error && <QueryError message={`${reminderMode ? "Reminders" : "Tells"} unavailable: ${query.error.message}`}
        onRetry={() => void query.refetch()} retrying={query.isFetching || busy} retryLabel={`Retry ${kind}`} />}
      {cancel.error && <p role="alert" className="text-sm text-destructive">Could not cancel {singular}: {cancel.error.message}</p>}
      {notice && <p role="status" className="text-sm">{notice}</p>}
      {data && <>
        <p className="text-xs text-muted-foreground">
          {query.error ? `Last successful ${singular} snapshot (may be stale)` : "Snapshot"}: {new Date(data.sampledAt).toLocaleString()}
        </p>
        <p className="text-sm">{data.total} {reminderMode ? "scheduled" : "pending"} {singular}{data.total === 1 ? "" : "s"} · Page {page}</p>
        {data.entries.length === 0
          ? <EmptyState>{data.total === 0 ? (reminderMode ? "No scheduled reminders." : "No pending tells.") : `No ${kind} on this page. Go back or refresh the list.`}</EmptyState>
          : <ul className="space-y-3">{data.entries.map((reminder) => <li key={reminder.id} className="min-w-0 rounded-md border p-3 space-y-2">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0 break-words text-sm">
                {"dueAt" in reminder ? <>
                <h3 className="font-medium break-words">{reminder.chatName || "Unknown chat"}</h3>
                <p className="break-all text-xs text-muted-foreground">{reminder.chatId}</p>
                <p>Recipient: {reminder.targetName || "Chat (no named recipient)"}</p>
                <p>Due: <time dateTime={new Date(reminder.dueAt).toISOString()}>{new Date(reminder.dueAt).toLocaleString()}</time></p>
                <p className="text-xs text-muted-foreground">{reminder.dueAt <= data.sampledAt
                  ? "Due now or overdue; awaiting handoff to delivery." : "Scheduled; not yet queued for delivery."}</p>
                </> : <>
                  <h3 className="font-medium">Recipient: {reminder.targetName}</h3>
                  {!reminder.legacy && <>
                    <p>Chat: {reminder.chatName || "Unknown chat"}</p>
                    <p className="break-all text-xs text-muted-foreground">{reminder.chatId}</p>
                    <p className="break-all text-xs text-muted-foreground">Identity: {reminder.targetId}</p>
                  </>}
                  <p>From: {reminder.fromName}</p>
                  <p>Created: <time dateTime={new Date(reminder.createdAt).toISOString()}>{new Date(reminder.createdAt).toLocaleString()}</time></p>
                  <p className="text-xs text-muted-foreground">{reminder.legacy
                    ? "Legacy tell — held; no verified chat/person identity. Cancel and recreate in WhatsApp."
                    : "Waiting for this person's activity in this chat; not yet queued for delivery."}</p>
                </>}
              </div>
              <Button type="button" variant="outline" disabled={busy || !!query.error}
                aria-label={`Cancel ${singular} ${reminder.id}`}
                onClick={() => {
                  if (window.confirm(`Cancel ${singular} #${reminder.id}? This cannot be undone. If already queued, it cannot be cancelled here.`)) {
                    cancel.mutate(reminder.id);
                  }
                }}>
                {busy && cancel.variables === reminder.id ? "Cancelling..." : `Cancel ${singular}`}
              </Button>
            </div>
            <p className="whitespace-pre-wrap break-words text-sm">{reminder.text}</p>
          </li>)}</ul>}
        <p className="text-xs text-muted-foreground">Times use your browser's local timezone. Queued delivery counts are available in Operations, not individual {singular} delivery history.</p>
      </>}
      <div className="flex flex-wrap gap-2">
        <Button type="button" variant="outline" disabled={page === 1 || busy} onClick={() => setPage((value) => value - 1)}>Previous {kind}</Button>
        <Button type="button" variant="outline" disabled={!data || !!query.error || query.isFetching || page * data.pageSize >= data.total || page >= 1_000_000 || busy}
          onClick={() => setPage((value) => value + 1)}>Next {kind}</Button>
      </div>
    </CardContent>
  </Card>;
}
