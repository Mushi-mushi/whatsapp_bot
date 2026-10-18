import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type ChatIdentity, type PendingTell, type ReminderRecurrence, type ScheduledReminder } from "@/lib/api";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "./ui/card";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Badge } from "./ui/badge";
import { EmptyState, LoadingState, QueryError } from "./QueryFeedback";

const SELECT_CLASS = "w-full rounded-md border border-input bg-background px-3 py-2 text-sm";

interface WaitingPage {
  entries: (ScheduledReminder | PendingTell)[];
  total: number;
  page: number;
  pageSize: number;
  sampledAt: number;
}

function toDatetimeLocal(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function defaultDueAtInput(): string {
  return toDatetimeLocal(Date.now() + 60 * 60_000);
}

function recurrenceBadge(r?: ReminderRecurrence): string {
  if (r === "daily") return "Repeats daily";
  if (r === "weekly") return "Repeats weekly";
  return "One-time";
}

export function ScheduledMessagesCard({ kind, chats = [] }: { kind: "reminders" | "tells"; chats?: ChatIdentity[] }) {
  const reminderMode = kind === "reminders";
  const singular = reminderMode ? "reminder" : "tell";
  const title = reminderMode ? "Reminder" : "Tell";
  const [page, setPage] = useState(1);
  const [notice, setNotice] = useState("");
  const [formError, setFormError] = useState("");
  const [chatId, setChatId] = useState("");
  const [targetName, setTargetName] = useState("");
  const [text, setText] = useState("");
  const [dueInput, setDueInput] = useState(defaultDueAtInput);
  const [recurrence, setRecurrence] = useState<ReminderRecurrence>("once");

  const [editingId, setEditingId] = useState<number | null>(null);
  const [editTargetName, setEditTargetName] = useState("");
  const [editText, setEditText] = useState("");
  const [editDueInput, setEditDueInput] = useState("");
  const [editRecurrence, setEditRecurrence] = useState<ReminderRecurrence>("once");
  const [editError, setEditError] = useState("");

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
  const create = useMutation({
    mutationFn: (payload: Parameters<typeof api.createReminder>[0]) => api.createReminder(payload),
    onMutate: () => {
      setNotice("");
      setFormError("");
    },
    onSuccess: (res) => {
      setNotice(`Reminder #${res.reminder.id} scheduled.`);
      setText("");
      setTargetName("");
      setRecurrence("once");
      setDueInput(defaultDueAtInput());
      void client.invalidateQueries({ queryKey: ["reminders"] });
    },
    onError: (err: Error) => setFormError(err.message),
  });
  const update = useMutation({
    mutationFn: ({ id, payload }: { id: number; payload: Parameters<typeof api.updateReminder>[1] }) =>
      api.updateReminder(id, payload),
    onMutate: () => {
      setNotice("");
      setEditError("");
    },
    onSuccess: (res) => {
      setNotice(`Reminder #${res.reminder.id} updated.`);
      setEditingId(null);
      void client.invalidateQueries({ queryKey: ["reminders"] });
    },
    onError: (err: Error) => setEditError(err.message),
  });
  const cancel = useMutation({
    mutationFn: (id: number) => reminderMode ? api.cancelReminder(id) : api.cancelTell(id),
    onMutate: async () => {
      setNotice("");
      await client.cancelQueries({ queryKey: [kind] });
    },
    onSuccess: (result) => {
      setNotice(`${title} #${result.cancelledId} cancelled before delivery.`);
      if (editingId === result.cancelledId) setEditingId(null);
      client.setQueriesData<WaitingPage>({ queryKey: [kind] }, (current) =>
        current?.entries.some((r) => r.id === result.cancelledId)
          ? { ...current, entries: current.entries.filter((r) => r.id !== result.cancelledId), total: Math.max(0, current.total - 1) }
          : current);
    },
    onSettled: () => client.invalidateQueries({ queryKey: [kind] }),
  });
  const data = query.data;
  const busy = cancel.isPending || create.isPending || update.isPending;

  const startEdit = (r: ScheduledReminder) => {
    setEditingId(r.id);
    setEditTargetName(r.targetName ?? "");
    setEditText(r.text);
    setEditDueInput(toDatetimeLocal(r.dueAt));
    setEditRecurrence(r.recurrence ?? "once");
    setEditError("");
  };

  const submitCreate = (e: React.FormEvent) => {
    e.preventDefault();
    const targetChat = chatId.trim();
    const msg = text.trim();
    const dueMs = new Date(dueInput).getTime();
    if (!targetChat) {
      setFormError("Select or enter a target chat ID.");
      return;
    }
    if (!msg) {
      setFormError("Enter a reminder message.");
      return;
    }
    if (!Number.isFinite(dueMs) || dueMs <= Date.now()) {
      setFormError("Due time must be in the future.");
      return;
    }
    create.mutate({
      chatId: targetChat,
      targetName: targetName.trim() || null,
      text: msg,
      dueAt: dueMs,
      recurrence,
    });
  };

  const submitEdit = (id: number) => {
    const msg = editText.trim();
    const dueMs = new Date(editDueInput).getTime();
    if (!msg) {
      setEditError("Enter a reminder message.");
      return;
    }
    if (!Number.isFinite(dueMs) || dueMs <= Date.now()) {
      setEditError("Due time must be in the future.");
      return;
    }
    update.mutate({
      id,
      payload: {
        targetName: editTargetName.trim() || null,
        text: msg,
        dueAt: dueMs,
        recurrence: editRecurrence,
      },
    });
  };

  return <Card>
    <CardHeader>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <CardTitle>{reminderMode ? "Scheduled reminders" : "Pending tells"}</CardTitle>
        <Button type="button" variant="outline" disabled={query.isFetching || busy} onClick={() => void query.refetch()}>
          Refresh {kind}
        </Button>
      </div>
      <CardDescription>
        {reminderMode ? "Create, edit, and cancel one-time or recurring reminders still waiting in the scheduler." : "New tells are bound to a person in one chat. Legacy name-only tells are held and will not be delivered automatically; they can still be cancelled here."}
        {" "}Refreshes every 10 seconds.
        Once handed to delivery, {kind} leave this list and cannot be cancelled here.
        Create {kind} in WhatsApp with {reminderMode ? "bot.remind [daily|weekly]" : "bot.tell"}.
      </CardDescription>
    </CardHeader>
    <CardContent className="space-y-4">
      {reminderMode && (
        <form onSubmit={submitCreate} className="space-y-3 rounded-md border bg-muted/20 p-3" aria-label="Schedule a reminder">
          <h3 className="text-sm font-medium">Schedule a reminder</h3>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <div className="space-y-1">
              <label htmlFor="reminder-chat" className="text-xs font-medium">Target chat</label>
              {chats.length > 0 ? (
                <select id="reminder-chat" className={SELECT_CLASS} value={chatId} onChange={(e) => setChatId(e.target.value)}>
                  <option value="">Select chat…</option>
                  {chats.map((c) => (
                    <option key={c.id} value={c.id}>{c.name} ({c.id})</option>
                  ))}
                </select>
              ) : (
                <Input id="reminder-chat" value={chatId} onChange={(e) => setChatId(e.target.value)} placeholder="e.g. 12345@g.us" />
              )}
            </div>
            <div className="space-y-1">
              <label htmlFor="reminder-target" className="text-xs font-medium">Recipient name (optional)</label>
              <Input id="reminder-target" value={targetName} onChange={(e) => setTargetName(e.target.value)} placeholder="Leave blank for whole chat" />
            </div>
            <div className="space-y-1">
              <label htmlFor="reminder-due" className="text-xs font-medium">Due date &amp; time</label>
              <Input id="reminder-due" type="datetime-local" value={dueInput} onChange={(e) => setDueInput(e.target.value)} />
            </div>
            <div className="space-y-1">
              <label htmlFor="reminder-recurrence" className="text-xs font-medium">Recurrence</label>
              <select id="reminder-recurrence" className={SELECT_CLASS} value={recurrence} onChange={(e) => setRecurrence(e.target.value as ReminderRecurrence)}>
                <option value="once">One-time</option>
                <option value="daily">Daily</option>
                <option value="weekly">Weekly</option>
              </select>
            </div>
          </div>
          <div className="flex flex-wrap items-end gap-2">
            <div className="min-w-0 flex-1 space-y-1">
              <label htmlFor="reminder-text" className="text-xs font-medium">Message</label>
              <Input id="reminder-text" value={text} onChange={(e) => setText(e.target.value)} placeholder="e.g. Standup in 5 minutes" />
            </div>
            <Button type="submit" disabled={busy}>
              {create.isPending ? "Scheduling..." : "Schedule reminder"}
            </Button>
          </div>
          {formError && <p role="alert" className="text-xs text-destructive">{formError}</p>}
        </form>
      )}
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
                <div className="flex flex-wrap items-center gap-2">
                  <h3 className="font-medium break-words">{reminder.chatName || "Unknown chat"}</h3>
                  <Badge variant="muted">{recurrenceBadge(reminder.recurrence)}</Badge>
                </div>
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
              <div className="flex flex-wrap gap-2">
                {"dueAt" in reminder && (
                  <Button type="button" variant="outline" disabled={busy || !!query.error}
                    aria-label={`Edit reminder ${reminder.id}`}
                    onClick={() => startEdit(reminder)}>
                    Edit
                  </Button>
                )}
                <Button type="button" variant="outline" disabled={busy || !!query.error}
                  aria-label={`Cancel ${singular} ${reminder.id}`}
                  onClick={() => {
                    if (window.confirm(`Cancel ${singular} #${reminder.id}? This cannot be undone. If already queued, it cannot be cancelled here.`)) {
                      cancel.mutate(reminder.id);
                    }
                  }}>
                  {cancel.isPending && cancel.variables === reminder.id ? "Cancelling..." : `Cancel ${singular}`}
                </Button>
              </div>
            </div>
            <p className="whitespace-pre-wrap break-words text-sm">{reminder.text}</p>
            {"dueAt" in reminder && editingId === reminder.id && (
              <div className="mt-2 space-y-3 rounded-md border bg-muted/20 p-3">
                <div className="grid gap-3 sm:grid-cols-3">
                  <div className="space-y-1">
                    <label htmlFor={`edit-target-${reminder.id}`} className="text-xs font-medium">Recipient name</label>
                    <Input id={`edit-target-${reminder.id}`} value={editTargetName} onChange={(e) => setEditTargetName(e.target.value)} placeholder="Chat (no named recipient)" />
                  </div>
                  <div className="space-y-1">
                    <label htmlFor={`edit-due-${reminder.id}`} className="text-xs font-medium">Due date &amp; time</label>
                    <Input id={`edit-due-${reminder.id}`} type="datetime-local" value={editDueInput} onChange={(e) => setEditDueInput(e.target.value)} />
                  </div>
                  <div className="space-y-1">
                    <label htmlFor={`edit-rec-${reminder.id}`} className="text-xs font-medium">Recurrence</label>
                    <select id={`edit-rec-${reminder.id}`} className={SELECT_CLASS} value={editRecurrence} onChange={(e) => setEditRecurrence(e.target.value as ReminderRecurrence)}>
                      <option value="once">One-time</option>
                      <option value="daily">Daily</option>
                      <option value="weekly">Weekly</option>
                    </select>
                  </div>
                </div>
                <div className="space-y-1">
                  <label htmlFor={`edit-text-${reminder.id}`} className="text-xs font-medium">Message</label>
                  <Input id={`edit-text-${reminder.id}`} value={editText} onChange={(e) => setEditText(e.target.value)} />
                </div>
                {editError && <p role="alert" className="text-xs text-destructive">{editError}</p>}
                <div className="flex gap-2">
                  <Button type="button" size="sm" disabled={busy} onClick={() => submitEdit(reminder.id)}>
                    {update.isPending ? "Saving..." : "Save reminder"}
                  </Button>
                  <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => setEditingId(null)}>
                    Discard
                  </Button>
                </div>
              </div>
            )}
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
