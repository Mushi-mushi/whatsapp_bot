import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, type ChatLeaderboards, type LeaderboardEntry, type TrophyEntry, type TrophyHistoryEntry } from "@/lib/api";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "./ui/card";
import { Button } from "./ui/button";
import { Badge } from "./ui/badge";
import { EmptyState, LoadingState, QueryError } from "./QueryFeedback";

const SELECT_CLASS = "w-full rounded-md border border-input bg-background px-3 py-2 text-sm";

function RankingList({
  title,
  entries,
  unit,
  emptyText,
}: {
  title: string;
  entries: LeaderboardEntry[];
  unit: string;
  emptyText: string;
}) {
  return (
    <div className="rounded-md border p-3 space-y-2">
      <h3 className="text-sm font-medium">{title}</h3>
      {entries.length === 0 ? (
        <p className="text-xs text-muted-foreground">{emptyText}</p>
      ) : (
        <ol className="space-y-1 text-sm">
          {entries.map((entry, idx) => (
            <li key={entry.senderId} className="flex items-center justify-between gap-2">
              <div className="min-w-0 truncate">
                <span className="font-medium">{idx + 1}. {entry.name}</span>{" "}
                <span className="text-xs text-muted-foreground">({entry.senderId})</span>
              </div>
              <Badge variant="muted">{entry.score} {unit}</Badge>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

function TrophiesList({
  title,
  trophies,
  history,
}: {
  title: string;
  trophies: TrophyEntry[];
  history: TrophyHistoryEntry[];
}) {
  return (
    <div className="rounded-md border p-3 space-y-2">
      <h3 className="text-sm font-medium">{title}</h3>
      {trophies.length === 0 ? (
        <p className="text-xs text-muted-foreground">No monthly trophies awarded yet.</p>
      ) : (
        <ul className="space-y-1 text-sm">
          {trophies.map((entry) => (
            <li key={entry.senderId} className="flex items-center justify-between gap-2">
              <div className="min-w-0 truncate">
                <span className="font-medium">🏆 {entry.name}</span>{" "}
                <span className="text-xs text-muted-foreground">({entry.senderId})</span>
              </div>
              <Badge variant="muted">{entry.trophies} {entry.trophies === 1 ? "trophy" : "trophies"}</Badge>
            </li>
          ))}
        </ul>
      )}
      {history.length > 0 && (
        <div className="border-t pt-2 space-y-1">
          <p className="text-xs font-medium text-muted-foreground">Recent monthly winners</p>
          <ul className="space-y-1 text-xs text-muted-foreground">
            {history.map((h) => (
              <li key={`${h.period}-${h.senderId}`}>
                {h.period}: <span className="text-foreground">{h.name}</span> ({h.score})
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

export function LeaderboardsCard() {
  const [selectedChatId, setSelectedChatId] = useState("");
  const query = useQuery({
    queryKey: ["leaderboards"],
    queryFn: api.getLeaderboards,
    refetchInterval: 15000,
    retry: false,
  });

  const chats = query.data?.chats ?? [];
  useEffect(() => {
    if (chats.length > 0 && !chats.some((c) => c.chatId === selectedChatId)) {
      setSelectedChatId(chats[0].chatId);
    }
  }, [chats, selectedChatId]);

  const activeChat: ChatLeaderboards | undefined =
    chats.find((c) => c.chatId === selectedChatId) ?? chats[0];

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <CardTitle>Leaderboards &amp; activity</CardTitle>
          <Button type="button" variant="outline" disabled={query.isFetching} onClick={() => void query.refetch()}>
            Refresh leaderboards
          </Button>
        </div>
        <CardDescription>
          Per-chat Trivia, Duel, Karma, Trophy standings and observed participant last-seen activity.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {query.isPending && <LoadingState>Loading leaderboards...</LoadingState>}
        {query.error && (
          <QueryError
            message={`Leaderboards unavailable: ${query.error.message}`}
            onRetry={() => void query.refetch()}
            retrying={query.isFetching}
            retryLabel="Retry leaderboards"
          />
        )}
        {query.data && (
          <>
            <p className="text-xs text-muted-foreground">
              Snapshot: {new Date(query.data.sampledAt).toLocaleString()}
            </p>
            {chats.length === 0 ? (
              <EmptyState>No chats available yet.</EmptyState>
            ) : (
              <>
                <div className="max-w-md space-y-1">
                  <label htmlFor="leaderboard-chat" className="text-xs font-medium">Chat</label>
                  <select
                    id="leaderboard-chat"
                    className={SELECT_CLASS}
                    value={activeChat?.chatId ?? ""}
                    onChange={(e) => setSelectedChatId(e.target.value)}
                  >
                    {chats.map((c) => (
                      <option key={c.chatId} value={c.chatId}>
                        {c.chatName ? `${c.chatName} (${c.chatId})` : c.chatId}
                      </option>
                    ))}
                  </select>
                </div>

                {activeChat && (
                  <div className="space-y-4">
                    <div className="grid gap-4 md:grid-cols-3">
                      <RankingList
                        title="Trivia (this month)"
                        entries={activeChat.trivia.monthly}
                        unit="pts"
                        emptyText="No trivia points this month."
                      />
                      <RankingList
                        title="Trivia (all-time)"
                        entries={activeChat.trivia.allTime}
                        unit="pts"
                        emptyText="No all-time trivia points yet."
                      />
                      <TrophiesList
                        title="Trivia trophies"
                        trophies={activeChat.trivia.trophies}
                        history={activeChat.trivia.history}
                      />
                    </div>

                    <div className="grid gap-4 md:grid-cols-3">
                      <RankingList
                        title="Duel wins (this month)"
                        entries={activeChat.duel.monthly}
                        unit="wins"
                        emptyText="No duel wins this month."
                      />
                      <RankingList
                        title="Duel wins (all-time)"
                        entries={activeChat.duel.allTime}
                        unit="wins"
                        emptyText="No all-time duel wins yet."
                      />
                      <TrophiesList
                        title="Duel trophies"
                        trophies={activeChat.duel.trophies}
                        history={activeChat.duel.history}
                      />
                    </div>

                    <div className="grid gap-4 md:grid-cols-2">
                      <RankingList
                        title="Karma"
                        entries={activeChat.karma}
                        unit="karma"
                        emptyText="No karma recorded in this chat yet."
                      />

                      <div className="rounded-md border p-3 space-y-2">
                        <h3 className="text-sm font-medium">Participants &amp; last seen</h3>
                        {activeChat.participants.length === 0 ? (
                          <p className="text-xs text-muted-foreground">No participant activity observed in this chat yet.</p>
                        ) : (
                          <ul className="space-y-1 text-sm">
                            {activeChat.participants.map((p) => (
                              <li key={p.senderId} className="flex flex-wrap items-center justify-between gap-2">
                                <div className="min-w-0 truncate">
                                  <span className="font-medium">{p.name}</span>{" "}
                                  <span className="text-xs text-muted-foreground">({p.senderId})</span>
                                </div>
                                <time className="text-xs text-muted-foreground" dateTime={new Date(p.lastSeenAt).toISOString()}>
                                  {new Date(p.lastSeenAt).toLocaleString()}
                                </time>
                              </li>
                            ))}
                          </ul>
                        )}
                      </div>
                    </div>
                  </div>
                )}
              </>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
