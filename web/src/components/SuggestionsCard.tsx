import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type SuggestionsResponse } from "@/lib/api";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "./ui/card";
import { Button } from "./ui/button";
import { Badge } from "./ui/badge";
import { EmptyState, LoadingState, QueryError } from "./QueryFeedback";

export function SuggestionsCard() {
  const [page, setPage] = useState(1);
  const [notice, setNotice] = useState("");
  const client = useQueryClient();

  const query = useQuery({
    queryKey: ["suggestions", page],
    queryFn: () => api.getSuggestions(page),
    refetchInterval: 15000,
    retry: false,
  });

  const remove = useMutation({
    mutationFn: (id: number) => api.deleteSuggestion(id),
    onMutate: async () => {
      setNotice("");
      await client.cancelQueries({ queryKey: ["suggestions"] });
    },
    onSuccess: (res) => {
      setNotice(`Suggestion #${res.deletedId} dismissed.`);
      client.setQueriesData<SuggestionsResponse>({ queryKey: ["suggestions"] }, (current) =>
        current?.suggestions.some((s) => s.id === res.deletedId)
          ? {
              ...current,
              suggestions: current.suggestions.filter((s) => s.id !== res.deletedId),
              total: Math.max(0, current.total - 1),
            }
          : current,
      );
    },
    onSettled: () => client.invalidateQueries({ queryKey: ["suggestions"] }),
  });

  const data = query.data;
  const busy = remove.isPending;

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <CardTitle>Feature suggestions</CardTitle>
          <Button type="button" variant="outline" disabled={query.isFetching || busy} onClick={() => void query.refetch()}>
            Refresh suggestions
          </Button>
        </div>
        <CardDescription>
          Explicit feature ideas submitted with <code>bot.suggest</code> and unrecognized <code>bot.xxxx</code> commands users tried in chat.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {query.isPending && <LoadingState>Loading suggestions...</LoadingState>}
        {query.error && (
          <QueryError
            message={`Suggestions unavailable: ${query.error.message}`}
            onRetry={() => void query.refetch()}
            retrying={query.isFetching || busy}
            retryLabel="Retry suggestions"
          />
        )}
        {remove.error && (
          <p role="alert" className="text-sm text-destructive">
            Could not dismiss suggestion: {remove.error.message}
          </p>
        )}
        {notice && <p role="status" className="text-sm">{notice}</p>}
        {data && (
          <>
            <p className="text-xs text-muted-foreground">
              Snapshot: {new Date(data.sampledAt).toLocaleString()}
            </p>
            <p className="text-sm">
              {data.total} logged suggestion{data.total === 1 ? "" : "s"} · Page {page}
            </p>
            {data.suggestions.length === 0 ? (
              <EmptyState>
                {data.total === 0
                  ? "No feature suggestions logged yet."
                  : "No suggestions on this page. Go back or refresh the list."}
              </EmptyState>
            ) : (
              <ul className="space-y-3">
                {data.suggestions.map((s) => (
                  <li key={s.id} className="min-w-0 rounded-md border p-3 space-y-2">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div className="min-w-0 break-words text-sm space-y-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <Badge variant={s.kind === "explicit" ? "default" : "muted"}>
                            {s.kind === "explicit" ? "Explicit (bot.suggest)" : `Unrecognized command (${s.command ?? "bot.*"})`}
                          </Badge>
                          <span className="font-medium">{s.senderName}</span>
                          <span className="text-xs text-muted-foreground">({s.senderId})</span>
                        </div>
                        <p className="text-xs text-muted-foreground">
                          Chat: {s.chatName ? `${s.chatName} (${s.chatId})` : s.chatId} ·{" "}
                          <time dateTime={new Date(s.createdAt).toISOString()}>
                            {new Date(s.createdAt).toLocaleString()}
                          </time>
                        </p>
                      </div>
                      <Button
                        type="button"
                        variant="outline"
                        disabled={busy || !!query.error}
                        aria-label={`Dismiss suggestion ${s.id}`}
                        onClick={() => remove.mutate(s.id)}
                      >
                        {busy && remove.variables === s.id ? "Dismissing..." : "Dismiss"}
                      </Button>
                    </div>
                    <p className="whitespace-pre-wrap break-words text-sm">{s.text}</p>
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
        <div className="flex flex-wrap gap-2">
          <Button type="button" variant="outline" disabled={page === 1 || busy} onClick={() => setPage((v) => v - 1)}>
            Previous suggestions
          </Button>
          <Button
            type="button"
            variant="outline"
            disabled={!data || !!query.error || query.isFetching || page * data.pageSize >= data.total || page >= 1_000_000 || busy}
            onClick={() => setPage((v) => v + 1)}
          >
            Next suggestions
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
