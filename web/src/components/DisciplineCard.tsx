import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { api, type ChatIdentity, type DisciplinePlayer } from "@/lib/api";
import { BedDouble, Loader2, Moon, Zap } from "lucide-react";

function remaining(until: number | null): string {
  if (until == null) return "";
  const ms = Math.max(0, until - Date.now());
  const mins = Math.floor(ms / 60000);
  const secs = Math.floor((ms % 60000) / 1000);
  return `${mins}m ${secs}s left`;
}

export function DisciplineCard({ chats }: { chats: ChatIdentity[] }) {
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
  const [minutes, setMinutes] = useState(10);
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
    const digits = jid.split("@")[0].replace(/\D/g, "");
    return contactList.find((c) => c.phone && c.phone.replace(/\D/g, "") === digits)?.name ?? null;
  }, [senderId, contactByJid, contactList]);

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ["discipline"] });

  const sleep = useMutation({
    mutationFn: () => api.sleepPlayer(chatId.trim(), senderId.trim(), minutes),
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
          <label className="space-y-1 text-sm">
            <span className="text-muted-foreground">Chat</span>
            <Input
              list="discipline-chats"
              placeholder="Chat id (e.g. 1203…@g.us)"
              value={chatId}
              onChange={(e) => setChatId(e.target.value)}
            />
            <datalist id="discipline-chats">
              {chats.map((c) => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </datalist>
          </label>
          <label className="space-y-1 text-sm">
            <span className="text-muted-foreground">Player</span>
            <Input
              list="discipline-players"
              placeholder="Pick a contact or paste a JID"
              value={senderId}
              onChange={(e) => setSenderId(e.target.value)}
            />
            <datalist id="discipline-players">
              {contactList.map((c) => (
                <option key={c.jid} value={c.jid}>
                  {c.name}{c.phone ? ` · ${c.phone}` : ""}
                </option>
              ))}
            </datalist>
            <span className="block text-xs text-muted-foreground">
              {senderId.trim()
                ? typedName
                  ? `Resolved: ${typedName}`
                  : "Unknown contact — the JID will be used as-is"
                : "Start typing a name to find a contact"}
            </span>
          </label>
          <label className="space-y-1 text-sm">
            <span className="text-muted-foreground">Sleep minutes (1–60)</span>
            <Input
              type="number"
              min={1}
              max={60}
              value={minutes}
              onChange={(e) => setMinutes(Math.min(60, Math.max(1, Number(e.target.value) || 1)))}
            />
          </label>
        </div>

        <div className="flex flex-wrap gap-2">
          <Button
            onClick={() => { setError(""); sleep.mutate(); }}
            disabled={!canSubmit || sleep.isPending}
          >
            {sleep.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <BedDouble className="h-4 w-4" />}
            Put to sleep now
          </Button>
          <Button
            variant="outline"
            onClick={() => { setError(""); arm.mutate(); }}
            disabled={!canSubmit || arm.isPending}
          >
            {arm.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Zap className="h-4 w-4" />}
            Arm next siesta
          </Button>
        </div>

        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        {players.error && (
          <p role="alert" className="text-sm text-destructive">
            Could not load players: {players.error.message}
          </p>
        )}

        <div className="space-y-2">
          <p className="text-sm font-medium">
            Sleeping &amp; armed players
            <span className="ml-2 rounded-full bg-primary/15 px-2 py-0.5 text-xs font-medium text-primary">
              {list.length}
            </span>
          </p>
          {list.length === 0 && (
            <p className="text-sm text-muted-foreground">No players are sleeping or armed.</p>
          )}
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
                  disabled={wake.isPending}
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
