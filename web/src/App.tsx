import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, ApiError, setToken, type BotConfig, type ConfigSnapshot, type Status } from "@/lib/api";
import { useStatusStream } from "@/lib/useStatusStream";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { StatusCard } from "@/components/StatusCard";
import { ApprovedSenders } from "@/components/ApprovedSenders";
import { GeneralCard } from "@/components/GeneralCard";
import { AiCard } from "@/components/AiCard";
import { PaintCard } from "@/components/PaintCard";
import { MemoryCard } from "@/components/MemoryCard";
import { ProfilesCard } from "@/components/ProfilesCard";
import { PetsCard } from "@/components/PetsCard";
import { DisciplineCard } from "@/components/DisciplineCard";
import { OperationsCard } from "@/components/OperationsCard";
import { RemindersCard } from "@/components/RemindersCard";
import { PendingTellsCard } from "@/components/PendingTellsCard";
import { FieldValidationProvider, useFieldErrors } from "@/components/fields";
import { LoadingState, QueryError } from "@/components/QueryFeedback";
import { AlarmClock, Bot, Brain, Check, Image, Loader2, Moon, RotateCw, ShieldCheck, SlidersHorizontal, Smartphone, Sparkles } from "lucide-react";

const isUnauthorized = (err: unknown) => err instanceof ApiError && err.status === 401;

type Tab = "connection" | "general" | "access" | "ai" | "paint" | "memory" | "pets" | "discipline" | "operations" | "reminders" | "tells";

// Which config fields live on which tab — drives the per-tab "unsaved" dot.
const TAB_FIELDS: Record<Tab, (keyof BotConfig)[]> = {
  connection: [],
  pets: [],
  discipline: [],
  operations: [],
  reminders: [],
  tells: [],
  general: [
    "transcriptionEnabled", "audioDownloadEnabled", "acknowledgeMedia", "deleteInstagramPosts",
    "instagramDeleteSenders", "respondToOwnCommands", "botReplyPrefix", "auralisBaseUrl",
    "transcriptionTimeoutSeconds",
    "retentionEnabled", "analyticsRetentionDays", "deliveryRetentionDays",
  ],
  access: ["approvedSenders"],
  ai: [
    "askEnabled", "ollamaModel", "ollamaBaseUrl", "ollamaTimeoutSeconds", "ollamaKeepAlive",
    "askSystemPrompt", "redditClientId", "redditClientSecret", "redditUserAgent", "redditRefreshToken",
  ],
  paint: [
    "paintEnabled", "paintBaseUrl", "paintCheckpoint", "paintFluxCheckpoint", "paintSampler",
    "paintScheduler", "paintSteps", "paintCfgScale", "paintWidth", "paintHeight",
    "paintDenoise", "paintGuidance", "paintNegativePrompt",
  ],
  memory: [
    "userMemoryEnabled", "userMemoryLimit", "userMemoryContext",
    "profileRefreshEvery", "profileMaxAgeDays", "profileSampleSize", "profileShortMaxChars",
  ],
};

function changedTabs(draft: BotConfig, baseline: BotConfig | null): Set<Tab> {
  const set = new Set<Tab>();
  if (!baseline) return set;
  for (const [tab, fields] of Object.entries(TAB_FIELDS) as [Tab, (keyof BotConfig)[]][]) {
    if (fields.some((f) => JSON.stringify(draft[f]) !== JSON.stringify(baseline[f]))) set.add(tab);
  }
  return set;
}

export default function App() {
  return <FieldValidationProvider><Dashboard /></FieldValidationProvider>;
}

function Dashboard() {
  const queryClient = useQueryClient();
  const fieldErrors = useFieldErrors();
  const hasInvalidFields = Object.keys(fieldErrors).length > 0;
  const status = useStatusStream();
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
  const [baseline, setBaseline] = useState<BotConfig | null>(null);
  const [saved, setSaved] = useState(false);
  const dirty = draft !== null && baseline !== null && JSON.stringify(draft) !== JSON.stringify(baseline);
  const [revision, setRevision] = useState("");
  const [tab, setTab] = useState<Tab>("connection");
  const [editorVersion, setEditorVersion] = useState(0);
  const selectTab = (next: Tab) => {
    if (hasInvalidFields) {
      document.getElementById(Object.keys(fieldErrors)[0])?.focus();
      return;
    }
    setTab(next);
  };

  useEffect(() => {
    if (configQuery.data && !dirty && !hasInvalidFields) {
      setDraft(configQuery.data.config);
      setBaseline(configQuery.data.config);
      setRevision(configQuery.data.revision);
    }
  }, [configQuery.data, dirty, hasInvalidFields]);

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
      setBaseline(res.config);
      setRevision(res.revision);
      queryClient.setQueryData(["config"], res);
      setSaved(true);
    },
  });

  if (isUnauthorized(configQuery.error) || isUnauthorized(saveMutation.error)) {
    return <TokenGate onSubmit={() => { saveMutation.reset(); void queryClient.invalidateQueries(); }} />;
  }

  if (!draft && configQuery.isError) {
    return <main className="mx-auto max-w-lg space-y-4 px-4 py-8">
      <QueryError message={`Configuration could not be loaded: ${configQuery.error.message}`}
        onRetry={() => void configQuery.refetch()} retrying={configQuery.isFetching} />
    </main>;
  }

  if (!draft) {
    return (
      <div className="flex h-screen items-center justify-center text-muted-foreground">
        <LoadingState>Loading configuration...</LoadingState>
      </div>
    );
  }

  const patch = (p: Partial<BotConfig>) => {
    setDraft((current) => current ? { ...current, ...p } : current);
    setSaved(false);
    saveMutation.reset();
  };

  const dirtyTabs = changedTabs(draft, baseline);

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
              if ((dirty || hasInvalidFields) && !window.confirm("Discard unsaved changes and reload?")) return;
              const result = await configQuery.refetch();
              if (result.data && !result.error) {
                setDraft(result.data.config);
                setBaseline(result.data.config);
                setRevision(result.data.revision);
                setEditorVersion((version) => version + 1);
                saveMutation.reset();
              }
              void chatsQuery.refetch();
            }}
          >
            <RotateCw className="h-4 w-4" /> Reload
          </Button>
          <Button onClick={() => saveMutation.mutate({ config: draft, revision })} disabled={!dirty || hasInvalidFields || saveMutation.isPending}>
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
      {hasInvalidFields && <p role="status" className="mb-3 text-sm text-destructive">
        Correct invalid settings before saving or changing sections: {Object.values(fieldErrors).join(", ")}. Reload can discard these edits.
      </p>}
      {saved && <p role="status" className="mb-3 text-sm text-muted-foreground">Configuration saved.</p>}
      {(saveMutation.error || configQuery.error) && <p role="alert" className="mb-4 text-sm text-destructive">{(saveMutation.error || configQuery.error)?.message}</p>}

      <StatusStrip status={status} model={draft.ollamaModel} aiEnabled={draft.askEnabled} />

      <nav aria-label="Dashboard sections" className="mb-4 flex flex-wrap gap-1 border-b">
        <TabButton active={tab === "connection"} onClick={() => selectTab("connection")}>
          <Smartphone className="h-4 w-4" /> Connection
        </TabButton>
        <TabButton active={tab === "general"} onClick={() => selectTab("general")} dirty={dirtyTabs.has("general")}>
          <SlidersHorizontal className="h-4 w-4" /> General
        </TabButton>
        <TabButton active={tab === "access"} onClick={() => selectTab("access")} dirty={dirtyTabs.has("access")}>
          <ShieldCheck className="h-4 w-4" /> Access
        </TabButton>
        <TabButton active={tab === "ai"} onClick={() => selectTab("ai")} enabled={draft.askEnabled} dirty={dirtyTabs.has("ai")}>
          <Sparkles className="h-4 w-4" /> AI
        </TabButton>
        <TabButton active={tab === "paint"} onClick={() => selectTab("paint")} enabled={draft.paintEnabled} dirty={dirtyTabs.has("paint")}>
          <Image className="h-4 w-4" /> Paint &amp; Film
        </TabButton>
        <TabButton active={tab === "memory"} onClick={() => selectTab("memory")} enabled={draft.userMemoryEnabled} dirty={dirtyTabs.has("memory")}>
          <Brain className="h-4 w-4" /> Memory &amp; profiles
        </TabButton>
        <TabButton active={tab === "pets"} onClick={() => selectTab("pets")}>
          <Sparkles className="h-4 w-4" /> Pets
        </TabButton>
        <TabButton active={tab === "discipline"} onClick={() => selectTab("discipline")}>
          <Moon className="h-4 w-4" /> Sleep
        </TabButton>
        <TabButton active={tab === "operations"} onClick={() => selectTab("operations")}>
          <SlidersHorizontal className="h-4 w-4" /> Operations
        </TabButton>
        <TabButton active={tab === "reminders"} onClick={() => selectTab("reminders")}>
          <AlarmClock className="h-4 w-4" /> Reminders
        </TabButton>
        <TabButton active={tab === "tells"} onClick={() => selectTab("tells")}>
          <Bot className="h-4 w-4" /> Pending tells
        </TabButton>
      </nav>

      {tab === "pets" && <PetsCard />}
      {tab === "operations" && <OperationsCard />}
      {tab === "reminders" && <RemindersCard />}
      {tab === "tells" && <PendingTellsCard />}

      {tab === "discipline" && (
        <div className="grid min-w-0 gap-4">
          {chatsQuery.isPending && <p role="status">Loading chats...</p>}
          {chatsQuery.error && <div>
            <p role="alert">Chat list could not be loaded: {chatsQuery.error.message}</p>
            <Button variant="outline" disabled={chatsQuery.isFetching} onClick={() => void chatsQuery.refetch()}>Retry chat list</Button>
          </div>}
          <DisciplineCard chats={chatsQuery.data?.chats ?? []} />
        </div>
      )}

      {tab === "connection" && (
        <div className="grid min-w-0 gap-4 lg:grid-cols-2">
          <StatusCard status={status} />
        </div>
      )}

      {tab === "general" && (
        <fieldset key={editorVersion} disabled={saveMutation.isPending} className="grid min-w-0 gap-4 lg:grid-cols-2">
          <GeneralCard config={draft} onChange={patch} />
        </fieldset>
      )}

      {tab === "access" && (
        <fieldset key={editorVersion} disabled={saveMutation.isPending} className="grid min-w-0 gap-4">
          <ApprovedSenders
            senders={draft.approvedSenders}
            chats={chatsQuery.data?.chats ?? []}
            onChange={(approvedSenders) => patch({ approvedSenders })}
            onRefreshChats={() => chatsQuery.refetch()}
            loading={chatsQuery.isPending}
            refreshing={chatsQuery.isFetching}
            error={chatsQuery.error?.message}
          />
        </fieldset>
      )}

      {tab === "ai" && (
        <fieldset key={editorVersion} disabled={saveMutation.isPending} className="grid min-w-0 gap-4 lg:grid-cols-2">
          <AiCard config={draft} onChange={patch} />
        </fieldset>
      )}

      {tab === "paint" && (
        <fieldset key={editorVersion} disabled={saveMutation.isPending} className="grid min-w-0 gap-4 lg:grid-cols-2">
          <PaintCard config={draft} onChange={patch} />
        </fieldset>
      )}

      {tab === "memory" && (
        <div className="grid min-w-0 gap-4 lg:grid-cols-2">
          <fieldset key={editorVersion} disabled={saveMutation.isPending} className="min-w-0 space-y-4">
            <MemoryCard config={draft} onChange={patch} />
          </fieldset>
          <div className="min-w-0 space-y-4">
            <ProfilesCard />
          </div>
        </div>
      )}
    </div>
  );
}

function TabButton({ active, onClick, enabled, dirty, children }: { active: boolean; onClick: () => void; enabled?: boolean; dirty?: boolean; children: React.ReactNode }) {
  return (
    <button
      type="button"
      aria-current={active ? "page" : undefined}
      onClick={onClick}
      className={
        "flex items-center gap-2 border-b-2 px-4 py-2 text-sm font-medium transition-colors " +
        (active
          ? "border-primary text-foreground"
          : "border-transparent text-muted-foreground hover:text-foreground")
      }
    >
      {children}
      {dirty ? (
        <span className="h-1.5 w-1.5 rounded-full bg-amber-400" title="Unsaved changes" />
      ) : enabled !== undefined ? (
        <span
          className={"h-1.5 w-1.5 rounded-full " + (enabled ? "bg-emerald-400" : "bg-muted-foreground/40")}
          title={enabled ? "Enabled" : "Disabled"}
        />
      ) : null}
    </button>
  );
}

const STRIP_STATE: Record<string, { text: string; dot: string }> = {
  open: { text: "Connected", dot: "bg-emerald-400" },
  connecting: { text: "Connecting…", dot: "bg-amber-400" },
  qr: { text: "Scan QR", dot: "bg-amber-400" },
  pairing: { text: "Pairing", dot: "bg-amber-400" },
  close: { text: "Disconnected", dot: "bg-destructive" },
};

function StatusStrip({ status, model, aiEnabled }: { status: Status | null; model: string; aiEnabled: boolean }) {
  const state = status?.state ?? "connecting";
  const stale = state === "open" && status?.health === "stale";
  const info = stale ? { text: "Needs re-link", dot: "bg-amber-400" } : STRIP_STATE[state] ?? STRIP_STATE.connecting;
  return (
    <div className="mb-4 flex flex-wrap items-center gap-x-4 gap-y-1 rounded-lg border bg-card px-4 py-2 text-sm">
      <span className="flex items-center gap-2 font-medium">
        <span className={"h-2 w-2 rounded-full " + info.dot} /> {info.text}
      </span>
      {status?.me && <span className="text-muted-foreground">{status.me}</span>}
      <span className="ml-auto flex items-center gap-1.5 text-muted-foreground">
        <Sparkles className="h-3.5 w-3.5" />
        {aiEnabled ? model : "AI off"}
      </span>
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
          aria-label="API token"
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
