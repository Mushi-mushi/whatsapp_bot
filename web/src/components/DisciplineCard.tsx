import { useId, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { api, type ChatIdentity, type DisciplinePlayer } from "@/lib/api";
import { BedDouble, Loader2, Moon, Zap } from "lucide-react";
import { EmptyState, LoadingState, QueryError } from "@/components/QueryFeedback";

function remaining(until: number | null): string {
  if (until == null) return "";
  const ms = Math.max(0, until - Date.now());
  const mins = Math.floor(ms / 60000);
  const secs = Math.floor((ms % 60000) / 1000);
  return `${mins}m ${secs}s left`;
}

export function DisciplineCard({ chats }: { chats: ChatIdentity[] }) {
  const id = useId();
  const queryClient = useQueryClient();
  const players = useQuery({
    queryKey: ["discipline"],
    queryFn: api.getDiscipline,
    refetchInterval: 10000,
  });
  const contacts = useQuery({
    queryKey: ["contacts"],
    queryFn: api.getContacts,
  });

  const [chatId, setChatId] = useState("");
  const [senderId, setSenderId] = useState("");
  const [minutes, setMinutes] = useState("10");
  const [error, setError] = useState("");

  const chatNames = useMemo(() => new Map(chats.map((c) => [c.id, c.name])), [chats]);
  const contactList = contacts.data?.contacts ?? [];
  const contactByJid = useMemo(
    () => new Map(contactList.map((c) => [c.jid, c.name])),
    [contactList],
  );
  // Resolve the display name for whatever is currently typed in the JID field.
  const typedName = useMemo(() => {
    const jid = senderId.trim();
    if (!jid) return null;
    const direct = contactByJid.get(jid);
    if (direct) return direct;
    const phone = /^(\d+)(?::\d+)?@s\.whatsapp\.net$/.exec(jid)?.[1];
    return phone ? contactList.find((c) => c.phone === phone)?.name ?? null : null;
  }, [senderId, contactByJid, contactList]);

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ["discipline"] });

  const sleep = useMutation({
    mutationFn: () => api.sleepPlayer(chatId.trim(), senderId.trim(), Number(minutes)),
    onSuccess: invalidate,
    onError: (e) => setError(e instanceof Error ? e.message : "Failed to put player to sleep."),
  });
  const arm = useMutation({
    mutationFn: () => api.armPlayer(chatId.trim(), senderId.trim()),
    onSuccess: invalidate,
    onError: (e) => setError(e instanceof Error ? e.message : "Failed to arm player."),
  });
  const wake = useMutation({
    mutationFn: (p: DisciplinePlayer) => api.wakePlayer(p.chatId, p.senderId),
    onSuccess: invalidate,
    onError: (e) => setError(e instanceof Error ? e.message : "Failed to wake player."),
  });

  const canSubmit = chatId.trim() !== "" && senderId.trim() !== "";
  const validMinutes = minutes.trim() !== "" && Number.isInteger(Number(minutes)) && Number(minutes) >= 1 && Number(minutes) <= 60;
  const busy = sleep.isPending || arm.isPending || wake.isPending;
  const list = players.data?.players ?? [];

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Moon className="h-4 w-4" /> Sleep &amp; discipline
        </CardTitle>
        <CardDescription>
          Each player may use <code>bot.siesta</code> once per UTC day per chat. A second
          attempt — or an armed player — is put to sleep: their messages are deleted (in groups
          where the bot is an admin) and they're told to go to bed. Put a player to sleep now, or
          arm them so their next siesta triggers it.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1 text-sm">
            <label htmlFor={`${id}-chat`} className="text-muted-foreground">Chat</label>
            <Input
              id={`${id}-chat`}
              list={`${id}-chats`}
              placeholder="Chat id (e.g. 1203…@g.us)"
              value={chatId}
              onChange={(e) => setChatId(e.target.value)}
            />
            <datalist id={`${id}-chats`}>
              {chats.map((c) => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </datalist>
          </div>
          <div className="space-y-1 text-sm">
            <label htmlFor={`${id}-player`} className="text-muted-foreground">Player</label>
            <Input
              id={`${id}-player`}
              aria-describedby={`${id}-player-hint`}
              list={`${id}-players`}
              placeholder="Pick a contact or paste a JID"
              value={senderId}
              onChange={(e) => setSenderId(e.target.value)}
            />
            <datalist id={`${id}-players`}>
              {contactList.map((c) => (
                <option key={c.jid} value={c.jid}>
                  {c.name}{c.phone ? ` · ${c.phone}` : ""}
                </option>
              ))}
            </datalist>
            <span id={`${id}-player-hint`} className="block text-xs text-muted-foreground">
              {senderId.trim()
                ? typedName
                  ? `Resolved: ${typedName}`
                  : "Unknown contact — the JID will be used as-is"
                : "Start typing a name to find a contact"}
            </span>
          </div>
          <div className="space-y-1 text-sm">
            <label htmlFor={`${id}-minutes`} className="text-muted-foreground">Sleep minutes (1–60)</label>
            <Input
              id={`${id}-minutes`}
              type="number"
              required
              min={1}
              max={60}
              step={1}
              value={minutes}
              aria-invalid={!validMinutes}
              aria-describedby={!validMinutes ? `${id}-minutes-error` : undefined}
              onChange={(e) => setMinutes(e.target.value)}
            />
          </div>
        </div>
        {!validMinutes && <p id={`${id}-minutes-error`} role="alert" className="text-sm text-destructive">Enter a whole number of sleep minutes from 1 to 60.</p>}
        {contacts.isPending && <LoadingState>Loading contacts...</LoadingState>}
        {contacts.error && <QueryError message={`Could not load contacts: ${contacts.error.message}`}
          onRetry={() => void contacts.refetch()} retrying={contacts.isFetching} retryLabel="Retry contacts" />}

        <div className="flex flex-wrap gap-2">
          <Button
            onClick={() => { setError(""); sleep.mutate(); }}
            disabled={!canSubmit || !validMinutes || busy}
          >
            {sleep.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <BedDouble className="h-4 w-4" />}
            Put to sleep now
          </Button>
          <Button
            variant="outline"
            onClick={() => { setError(""); arm.mutate(); }}
            disabled={!canSubmit || busy}
          >
            {arm.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Zap className="h-4 w-4" />}
            Arm next siesta
          </Button>
        </div>

        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        {players.error && <QueryError message={`Could not load players: ${players.error.message}`}
          onRetry={() => void players.refetch()} retrying={players.isFetching} retryLabel="Retry players" />}

        <div className="space-y-2">
          <p className="text-sm font-medium">
            Sleeping &amp; armed players
            {players.data && <span className="ml-2 rounded-full bg-primary/15 px-2 py-0.5 text-xs font-medium text-primary">
              {list.length}
            </span>}
          </p>
          {players.isPending && <LoadingState>Loading players...</LoadingState>}
          {players.isSuccess && list.length === 0 && <EmptyState>No players are sleeping or armed.</EmptyState>}
          {list.map((p) => {
            const name = p.displayName ?? contactByJid.get(p.senderId) ?? null;
            return (
              <div
                key={`${p.chatId}:${p.senderId}`}
                className="flex items-center justify-between gap-2 rounded-md border border-input bg-background/40 p-2"
              >
                <div className="min-w-0 text-sm">
                  <p className="truncate font-medium">{name ?? p.senderId}</p>
                  <p className="truncate text-muted-foreground">
                    {name ? `${p.senderId} · ` : ""}
                    {p.chatName ?? chatNames.get(p.chatId) ?? p.chatId}
                    {" · "}
                    {p.sleepUntil != null
                      ? `Asleep (${remaining(p.sleepUntil)})`
                      : p.armed
                        ? "Armed — next siesta sleeps them"
                        : ""}
                  </p>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => { setError(""); wake.mutate(p); }}
                  disabled={busy}
                  aria-label={`Wake ${name ?? p.senderId} in ${p.chatId}`}
                >
                  Wake
                </Button>
              </div>
            );
          })}
        </div>
      </CardContent>
    </Card>
  );
}
