import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { api, type ProfileSummary } from "@/lib/api";
import { Brain, ChevronDown, ChevronRight, Loader2, RotateCw, Trash2 } from "lucide-react";
import { EmptyState, LoadingState, QueryError } from "@/components/QueryFeedback";

function timeAgo(ts: number): string {
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

export function ProfilesCard() {
  const queryClient = useQueryClient();
  const profilesQuery = useQuery({ queryKey: ["profiles"], queryFn: api.getProfiles });
  const [openKey, setOpenKey] = useState<string | null>(null);

  const detailQuery = useQuery({
    queryKey: ["profile", openKey],
    queryFn: () => api.getProfile(openKey as string),
    enabled: !!openKey,
  });

  const refreshMutation = useMutation({
    mutationFn: (key: string) => api.refreshProfile(key),
    onSuccess: (_res, key) => {
      void queryClient.invalidateQueries({ queryKey: ["profiles"] });
      void queryClient.invalidateQueries({ queryKey: ["profile", key] });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (key: string) => api.deleteProfile(key),
    onSuccess: (_res, key) => {
      if (openKey === key) setOpenKey(null);
      queryClient.removeQueries({ queryKey: ["profile", key], exact: true });
      void queryClient.invalidateQueries({ queryKey: ["profiles"] });
    },
  });

  const profiles = profilesQuery.data?.profiles ?? [];

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between">
        <CardTitle className="flex items-center gap-2">
          <Brain className="h-4 w-4" /> Learned profiles
        </CardTitle>
        <Button aria-label="Refresh profiles" variant="outline" size="sm" onClick={() => profilesQuery.refetch()} disabled={profilesQuery.isFetching}>
          {profilesQuery.isFetching ? <Loader2 className="h-4 w-4 animate-spin" /> : <RotateCw className="h-4 w-4" />}
        </Button>
      </CardHeader>
      <CardContent className="space-y-2">
        {profilesQuery.isLoading && (
          <LoadingState>Loading profiles...</LoadingState>
        )}
        {profilesQuery.isError && (
          <QueryError message={profilesQuery.error.message} onRetry={() => void profilesQuery.refetch()} retrying={profilesQuery.isFetching} retryLabel="Retry profiles" />
        )}
        {!profilesQuery.isLoading && !profilesQuery.isError && profiles.length === 0 && (
          <EmptyState>
            No profiles yet. The bot learns separately about each person in each chat.
          </EmptyState>
        )}

        {profiles.map((p) => (
          <ProfileRow
            key={p.sender_key}
            profile={p}
            open={openKey === p.sender_key}
            deep={openKey === p.sender_key ? detailQuery.data?.deep : undefined}
            deepLoading={openKey === p.sender_key && detailQuery.isLoading}
            deepRetrying={openKey === p.sender_key && detailQuery.isFetching}
            deepError={openKey === p.sender_key ? detailQuery.error?.message : undefined}
            onRetryDetail={() => void detailQuery.refetch()}
            onToggle={() => setOpenKey((k) => (k === p.sender_key ? null : p.sender_key))}
            onRefresh={() => refreshMutation.mutate(p.sender_key)}
            onDelete={() => {
              if (window.confirm(`Forget everything learned about ${p.name} in ${p.chat_name ? `${p.chat_name} (${p.chat_id})` : p.chat_id}? This deletes their profile and stored messages in this chat only.`)) {
                deleteMutation.mutate(p.sender_key);
              }
            }}
            refreshing={refreshMutation.isPending && refreshMutation.variables === p.sender_key}
            deleting={deleteMutation.isPending && deleteMutation.variables === p.sender_key}
            refreshError={
              refreshMutation.isError && refreshMutation.variables === p.sender_key
                ? refreshMutation.error.message
                : undefined
            }
            deleteError={deleteMutation.isError && deleteMutation.variables === p.sender_key
              ? deleteMutation.error.message : undefined}
          />
        ))}
      </CardContent>
    </Card>
  );
}

interface RowProps {
  profile: ProfileSummary;
  open: boolean;
  deep?: string;
  deepLoading: boolean;
  deepRetrying: boolean;
  deepError?: string;
  onRetryDetail: () => void;
  onToggle: () => void;
  onRefresh: () => void;
  onDelete: () => void;
  refreshing: boolean;
  deleting: boolean;
  refreshError?: string;
  deleteError?: string;
}

function ProfileRow({ profile, open, deep, deepLoading, deepRetrying, deepError, onRetryDetail, onToggle, onRefresh, onDelete, refreshing, deleting, refreshError, deleteError }: RowProps) {
  return (
    <div className="rounded-md border">
      <div className="flex items-start gap-2 p-3">
        <button type="button" onClick={onToggle} className="mt-0.5 shrink-0 text-muted-foreground hover:text-foreground" aria-label={open ? "Collapse" : "Expand"} aria-expanded={open}>
          {open ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
        </button>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <p className="truncate text-sm font-medium">{profile.name}</p>
            <Badge variant="muted">{profile.messageCount} msgs</Badge>
            <span className="text-xs text-muted-foreground">{timeAgo(profile.updated_at)}</span>
          </div>
          <p className="text-xs text-muted-foreground">
            {profile.chat_name ?? "Chat"} <span className="break-all">({profile.chat_id})</span>
          </p>
          <p className="mt-1 text-sm text-muted-foreground">{profile.short || "(no summary)"}</p>
          {open && (
            <div className="mt-2 border-t pt-2">
              {deepLoading ? (
                <LoadingState>Loading dossier…</LoadingState>
              ) : deepError ? (
                <QueryError message={deepError} onRetry={onRetryDetail} retrying={deepRetrying} retryLabel="Retry dossier" />
              ) : (
                <pre className="whitespace-pre-wrap break-words font-sans text-sm text-foreground">{deep}</pre>
              )}
            </div>
          )}
          {refreshError && <p role="alert" className="mt-1 text-xs text-destructive">{refreshError}</p>}
          {deleteError && <p role="alert" className="mt-1 text-xs text-destructive">{deleteError}</p>}
        </div>
        <div className="flex shrink-0 gap-1">
          <Button aria-label={`Rebuild profile for ${profile.name} in ${profile.chat_id}`} variant="outline" size="sm" onClick={onRefresh} disabled={refreshing || deleting} title="Rebuild profile now">
            {refreshing ? <Loader2 className="h-4 w-4 animate-spin" /> : <RotateCw className="h-4 w-4" />}
          </Button>
          <Button aria-label={`Forget ${profile.name} in ${profile.chat_id}`} variant="outline" size="sm" onClick={onDelete} disabled={deleting || refreshing} title="Forget this user">
            {deleting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
          </Button>
        </div>
      </div>
    </div>
  );
}
