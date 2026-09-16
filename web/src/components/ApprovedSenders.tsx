import { useMemo, useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Check, Plus, RefreshCw, Search, X } from "lucide-react";
import type { BotConfig } from "@/lib/api";

function normalize(name: string): string {
  return name
    .normalize("NFKD")
    .replace(/[\u0300-\u036f\u200d\uFE0F]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

interface Props {
  senders: string[];
  chats: string[];
  onChange: (senders: string[]) => void;
  onRefreshChats: () => void;
}

export function ApprovedSenders({ senders, chats, onChange, onRefreshChats }: Props) {
  const [search, setSearch] = useState("");

  const approvedNorms = useMemo(() => new Set(senders.map(normalize)), [senders]);
  const available = useMemo(
    () => chats.filter((c) => !approvedNorms.has(normalize(c))),
    [chats, approvedNorms],
  );
  const filtered = useMemo(() => {
    const q = normalize(search);
    return q ? available.filter((c) => normalize(c).includes(q)) : available;
  }, [available, search]);
  const shown = filtered.slice(0, 50);

  function add(name: string) {
    const value = name.trim();
    if (!value || approvedNorms.has(normalize(value))) return;
    onChange([...senders, value]);
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          Approved Senders
          <span className="rounded-full bg-primary/15 px-2 py-0.5 text-xs font-medium text-primary">
            {senders.length}
          </span>
        </CardTitle>
        <CardDescription>Only these chats are processed by the bot.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap gap-2">
          {senders.length === 0 && (
            <span className="text-sm text-muted-foreground">
              None yet — search below to add a chat.
            </span>
          )}
          {senders.map((name, i) => (
            <span
              key={name}
              className="inline-flex max-w-full items-center gap-1.5 rounded-full border border-primary/20 bg-primary/10 py-1 pl-3 pr-1.5 text-sm text-foreground"
            >
              <Check className="h-3.5 w-3.5 shrink-0 text-primary" />
              <span className="truncate">{name}</span>
              <button
                onClick={() => onChange(senders.filter((_, idx) => idx !== i))}
                className="grid h-5 w-5 shrink-0 place-items-center rounded-full text-muted-foreground transition hover:bg-destructive/15 hover:text-destructive"
                aria-label={`Remove ${name}`}
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </span>
          ))}
        </div>

        <div className="rounded-lg border border-input bg-background/40">
          <div className="flex items-center gap-2 border-b border-input p-2">
            <div className="relative flex-1">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                placeholder="Search chats to add…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="border-0 bg-transparent pl-8 focus-visible:ring-0"
              />
            </div>
            <Button
              variant="ghost"
              size="icon"
              onClick={onRefreshChats}
              title="Refresh chat list"
              className="shrink-0"
            >
              <RefreshCw className="h-4 w-4" />
            </Button>
          </div>

          <div className="max-h-56 overflow-auto p-1">
            {shown.length === 0 ? (
              <div className="px-3 py-6 text-center text-sm text-muted-foreground">
                {available.length === 0 ? "No chats synced yet." : "No matches."}
              </div>
            ) : (
              shown.map((c) => (
                <button
                  key={c}
                  onClick={() => {
                    add(c);
                    setSearch("");
                  }}
                  className="group flex w-full items-center justify-between gap-2 rounded-md px-3 py-2 text-left text-sm transition hover:bg-muted"
                  title={c}
                >
                  <span className="truncate">{c}</span>
                  <Plus className="h-4 w-4 shrink-0 text-muted-foreground opacity-0 transition group-hover:opacity-100" />
                </button>
              ))
            )}
          </div>

          {filtered.length > shown.length && (
            <div className="border-t border-input px-3 py-1.5 text-xs text-muted-foreground">
              Showing {shown.length} of {filtered.length} — keep typing to narrow.
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

export type { BotConfig };
