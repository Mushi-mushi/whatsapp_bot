import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, ApiError, setToken, type BotConfig, type ConfigSnapshot } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { StatusCard } from "@/components/StatusCard";
import { ApprovedSenders } from "@/components/ApprovedSenders";
import { SettingsCard } from "@/components/SettingsCard";
import { Bot, Check, Loader2, RotateCw } from "lucide-react";

const isUnauthorized = (err: unknown) => err instanceof ApiError && err.status === 401;

export default function App() {
  const queryClient = useQueryClient();
  const configQuery = useQuery({
    queryKey: ["config"],
    queryFn: api.getConfig,
    retry: (count, err) => !isUnauthorized(err) && count < 3,
  });
  const chatsQuery = useQuery({
    queryKey: ["chats"],
    queryFn: api.getChats,
    retry: (count, err) => !isUnauthorized(err) && count < 3,
  });

  const [draft, setDraft] = useState<BotConfig | null>(null);
  const [saved, setSaved] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [revision, setRevision] = useState("");

  useEffect(() => {
    if (configQuery.data && !dirty) {
      setDraft(configQuery.data.config);
      setRevision(configQuery.data.revision);
    }
  }, [configQuery.data, dirty]);

  useEffect(() => {
    if (!saved) return;
    const timer = setTimeout(() => setSaved(false), 1500);
    return () => clearTimeout(timer);
  }, [saved]);

  const saveMutation = useMutation({
    mutationFn: (snapshot: ConfigSnapshot) => api.saveConfig(snapshot),
    onMutate: () => queryClient.cancelQueries({ queryKey: ["config"] }),
    onSuccess: (res) => {
      setDraft(res.config);
      setRevision(res.revision);
      queryClient.setQueryData(["config"], res);
      setDirty(false);
      setSaved(true);
    },
  });

  if (isUnauthorized(configQuery.error) || isUnauthorized(saveMutation.error)) {
    return <TokenGate onSubmit={() => { saveMutation.reset(); void queryClient.invalidateQueries(); }} />;
  }

  if (!draft && configQuery.isError) {
    return <main className="mx-auto max-w-lg space-y-4 px-4 py-8">
      <p role="alert">Configuration could not be loaded: {configQuery.error.message}</p>
      <Button onClick={() => void configQuery.refetch()}><RotateCw className="h-4 w-4" /> Retry</Button>
    </main>;
  }

  if (!draft) {
    return (
      <div className="flex h-screen items-center justify-center text-muted-foreground">
        <Loader2 className="mr-2 h-5 w-5 animate-spin" /> Loading…
      </div>
    );
  }

  const patch = (p: Partial<BotConfig>) => {
    setDraft((current) => current ? { ...current, ...p } : current);
    setDirty(true);
    setSaved(false);
    saveMutation.reset();
  };

  return (
    <div className="mx-auto max-w-6xl px-4 py-8">
      <header className="mb-6 flex flex-col items-start justify-between gap-4 sm:flex-row sm:items-center">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-primary/15 text-primary">
            <Bot className="h-5 w-5" />
          </div>
          <div>
            <h1 className="text-xl font-semibold tracking-tight">WhatsApp Bot</h1>
            <p className="text-sm text-muted-foreground">Control panel</p>
          </div>
        </div>
        <div className="flex shrink-0 gap-2 self-end sm:self-auto">
          <Button
            variant="outline"
            disabled={saveMutation.isPending}
            onClick={async () => {
              if (dirty && !window.confirm("Discard unsaved changes and reload?")) return;
              const result = await configQuery.refetch();
              if (result.data && !result.error) {
                setDraft(result.data.config);
                setRevision(result.data.revision);
                setDirty(false);
                saveMutation.reset();
              }
              void chatsQuery.refetch();
            }}
          >
            <RotateCw className="h-4 w-4" /> Reload
          </Button>
          <Button onClick={() => saveMutation.mutate({ config: draft, revision })} disabled={!dirty || saveMutation.isPending}>
            {saveMutation.isPending ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : saved ? (
              <Check className="h-4 w-4" />
            ) : null}
            Save changes
          </Button>
        </div>
      </header>

      {dirty && <p className="mb-3 text-sm text-muted-foreground">Unsaved changes</p>}
      {(saveMutation.error || configQuery.error) && <p role="alert" className="mb-4 text-sm text-destructive">{(saveMutation.error || configQuery.error)?.message}</p>}
      <fieldset disabled={saveMutation.isPending} className="grid min-w-0 gap-4 lg:grid-cols-2">
        <div className="space-y-4">
          <StatusCard />
          <SettingsCard config={draft} onChange={patch} />
        </div>
        <div className="space-y-4">
          <ApprovedSenders
            senders={draft.approvedSenders}
            chats={chatsQuery.data?.chats ?? []}
            onChange={(approvedSenders) => patch({ approvedSenders })}
            onRefreshChats={() => chatsQuery.refetch()}
          />
        </div>
      </fieldset>
    </div>
  );
}

function TokenGate({ onSubmit }: { onSubmit: () => void }) {
  const [value, setValue] = useState("");
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    setToken(value);
    onSubmit();
  };
  return (
    <div className="flex h-screen items-center justify-center px-4">
      <form onSubmit={submit} className="w-full max-w-sm space-y-4 text-center">
        <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-xl bg-primary/15 text-primary">
          <Bot className="h-6 w-6" />
        </div>
        <div>
          <h1 className="text-lg font-semibold tracking-tight">Access token required</h1>
          <p className="text-sm text-muted-foreground">Enter the API token to continue.</p>
        </div>
        <Input
          type="password"
          autoFocus
          placeholder="API token"
          value={value}
          onChange={(e) => setValue(e.target.value)}
        />
        <Button type="submit" className="w-full" disabled={!value.trim()}>
          Unlock
        </Button>
      </form>
    </div>
  );
}
