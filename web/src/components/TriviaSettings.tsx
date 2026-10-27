import { useId, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Ban, Loader2, Unlock } from "lucide-react";
import { api } from "@/lib/api";
import type { TriviaBanRequest } from "../../../shared/api.js";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { EmptyState, LoadingState, QueryError } from "./QueryFeedback";

export function TriviaSettings() {
  const id = useId();
  const client = useQueryClient();
  const settings = useQuery({ queryKey: ["trivia-settings"], queryFn: api.getTriviaSettings, refetchInterval: 30_000, retry: false });
  const chats = useQuery({ queryKey: ["chats"], queryFn: api.getChats, retry: false });
  const [chatId, setChatId] = useState("");
  const [categoryId, setCategoryId] = useState("");
  const [days, setDays] = useState("7");
  const [notice, setNotice] = useState("");
  const selectedChat = chatId || chats.data?.chats[0]?.id || "";
  const selectedCategory = categoryId || String(settings.data?.categories[0]?.id ?? "");
  const duration = Number(days);
  const validDuration = days.trim() !== "" && Number.isInteger(duration) && duration >= 1 && duration <= 365;
  const ban = useMutation({
    mutationFn: (request: TriviaBanRequest) => api.banTriviaCategory(request),
    onSuccess: () => { setNotice("Category banned. Announcement queued."); void client.invalidateQueries({ queryKey: ["trivia-settings"] }); },
  });
  const unban = useMutation({
    mutationFn: api.unbanTriviaCategory,
    onSuccess: () => { setNotice("Category available again."); void client.invalidateQueries({ queryKey: ["trivia-settings"] }); },
  });
  const busy = ban.isPending || unban.isPending;
  const activeBans = settings.data?.bans.filter((entry) => entry.chatId === selectedChat && entry.until > Date.now()) ?? [];
  const reset = () => { setNotice(""); ban.reset(); unban.reset(); };
  const selectClass = "h-9 w-full min-w-0 rounded-md border border-input bg-background px-3 text-sm";

  return <section aria-labelledby={`${id}-title`} className="min-w-0 space-y-5">
    <h2 id={`${id}-title`} className="text-lg font-semibold">Trivia</h2>
    {settings.isPending && <LoadingState>Loading trivia settings...</LoadingState>}
    {settings.error && <QueryError message={`Trivia settings unavailable: ${settings.error.message}`} onRetry={() => void settings.refetch()} retrying={settings.isFetching} />}
    {chats.isPending && <LoadingState>Loading chats...</LoadingState>}
    {chats.error && <QueryError message={`Chats unavailable: ${chats.error.message}`} onRetry={() => void chats.refetch()} retrying={chats.isFetching} />}
    {chats.data && chats.data.chats.length === 0 && <EmptyState>No chats available.</EmptyState>}
    {settings.data && chats.data && chats.data.chats.length > 0 && <>
      <form className="grid items-end gap-3 sm:grid-cols-2 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_7rem_auto]" onSubmit={(event) => {
        event.preventDefault();
        if (!validDuration || !selectedChat || !selectedCategory || busy) return;
        reset();
        ban.mutate({ chatId: selectedChat, categoryId: Number(selectedCategory), days: duration });
      }}>
        <div className="min-w-0 space-y-1">
          <label htmlFor={`${id}-chat`} className="text-sm text-muted-foreground">Chat</label>
          <select id={`${id}-chat`} className={selectClass} value={selectedChat} disabled={busy} onChange={(event) => { setChatId(event.target.value); reset(); }}>
            {chats.data.chats.map((chat) => <option key={chat.id} value={chat.id}>{chat.name}</option>)}
          </select>
        </div>
        <div className="min-w-0 space-y-1">
          <label htmlFor={`${id}-category`} className="text-sm text-muted-foreground">Category</label>
          <select id={`${id}-category`} className={selectClass} value={selectedCategory} disabled={busy} onChange={(event) => { setCategoryId(event.target.value); reset(); }}>
            {settings.data.categories.map((category) => <option key={category.id} value={category.id}>{category.name}</option>)}
          </select>
        </div>
        <div className="space-y-1">
          <label htmlFor={`${id}-days`} className="text-sm text-muted-foreground">Days</label>
          <Input id={`${id}-days`} type="number" min="1" max="365" step="1" required value={days} disabled={busy}
            aria-invalid={!validDuration} onChange={(event) => { setDays(event.target.value); reset(); }} />
        </div>
        <Button type="submit" disabled={busy || !validDuration || !selectedCategory}>
          {ban.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Ban className="h-4 w-4" />} Ban &amp; announce
        </Button>
      </form>
      {!validDuration && <p role="alert" className="text-sm text-destructive">Enter a whole number of days from 1 to 365.</p>}
      {(ban.error || unban.error) && <p role="alert" className="text-sm text-destructive">{(ban.error || unban.error)?.message}</p>}
      {notice && <p role="status" className="text-sm">{notice}</p>}
      <div className="space-y-2 border-t pt-4">
        <h3 className="font-medium">Unavailable categories</h3>
        {activeBans.length === 0 && <EmptyState>No active category bans in this chat.</EmptyState>}
        <ul className="divide-y">
          {activeBans.map((entry) => {
            const name = settings.data.categories.find((category) => category.id === entry.categoryId)?.name ?? String(entry.categoryId);
            return <li key={entry.categoryId} className="flex min-w-0 items-center justify-between gap-3 py-3">
              <div className="min-w-0 text-sm"><p className="break-words font-medium">{name}</p>
                <p className="break-words text-muted-foreground">Until <time dateTime={new Date(entry.until).toISOString()}>{new Date(entry.until).toLocaleString()}</time></p>
              </div>
              <Button variant="outline" disabled={busy} title={`Unban ${name}`} aria-label={`Unban ${name}`} onClick={() => {
                reset(); unban.mutate({ chatId: selectedChat, categoryId: entry.categoryId });
              }}><Unlock className="h-4 w-4" /></Button>
            </li>;
          })}
        </ul>
      </div>
    </>}
  </section>;
}