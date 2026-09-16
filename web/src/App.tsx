import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type BotConfig } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { StatusCard } from "@/components/StatusCard";
import { ApprovedSenders } from "@/components/ApprovedSenders";
import { SettingsCard } from "@/components/SettingsCard";
import { Bot, Check, Loader2, RotateCw } from "lucide-react";

export default function App() {
  const queryClient = useQueryClient();
  const configQuery = useQuery({ queryKey: ["config"], queryFn: api.getConfig });
  const chatsQuery = useQuery({ queryKey: ["chats"], queryFn: api.getChats });

  const [draft, setDraft] = useState<BotConfig | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (configQuery.data) setDraft(configQuery.data);
  }, [configQuery.data]);

  const saveMutation = useMutation({
    mutationFn: (config: BotConfig) => api.saveConfig(config),
    onSuccess: (res) => {
      setDraft(res.config);
      queryClient.invalidateQueries({ queryKey: ["config"] });
      setSaved(true);
      setTimeout(() => setSaved(false), 1500);
    },
  });

  if (!draft) {
    return (
      <div className="flex h-screen items-center justify-center text-muted-foreground">
        <Loader2 className="mr-2 h-5 w-5 animate-spin" /> Loading…
      </div>
    );
  }

  const patch = (p: Partial<BotConfig>) => setDraft({ ...draft, ...p });

  return (
    <div className="mx-auto max-w-6xl px-4 py-8">
      <header className="mb-6 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-primary/15 text-primary">
            <Bot className="h-5 w-5" />
          </div>
          <div>
            <h1 className="text-xl font-semibold tracking-tight">WhatsApp Bot</h1>
            <p className="text-sm text-muted-foreground">Control panel</p>
          </div>
        </div>
        <div className="flex gap-2">
          <Button
            variant="outline"
            onClick={() => {
              configQuery.refetch();
              chatsQuery.refetch();
            }}
          >
            <RotateCw className="h-4 w-4" /> Reload
          </Button>
          <Button onClick={() => saveMutation.mutate(draft)} disabled={saveMutation.isPending}>
            {saveMutation.isPending ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : saved ? (
              <Check className="h-4 w-4" />
            ) : null}
            Save changes
          </Button>
        </div>
      </header>

      <div className="grid gap-4 lg:grid-cols-2">
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
      </div>
    </div>
  );
}
