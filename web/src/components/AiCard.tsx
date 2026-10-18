import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { Button } from "@/components/ui/button";
import { api, type BotConfig } from "@/lib/api";
import { Row, TextField, NumberField, TextAreaField } from "@/components/fields";
import { CheckCircle2, Loader2, Plug, XCircle } from "lucide-react";
import { QueryError } from "@/components/QueryFeedback";

interface Props {
  config: BotConfig;
  onChange: (patch: Partial<BotConfig>) => void;
}

export function AiCard({ config, onChange }: Props) {
  const modelsQuery = useQuery({ queryKey: ["ollama-models"], queryFn: api.getOllamaModels });
  const models = modelsQuery.data?.models ?? [];
  const reachable = modelsQuery.isSuccess && !modelsQuery.isError;
  const options = models.includes(config.ollamaModel)
    ? models
    : [config.ollamaModel, ...models].filter(Boolean);

  return (
    <Card>
      <CardHeader>
        <CardTitle>AI (Ollama)</CardTitle>
        <CardDescription>Local LLM powering bot.ask, bot.translate, bot.tldr and profiles.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-1">
        <Row label="AI ask" hint="Enable bot.ask via your local Ollama">
          <Switch checked={config.askEnabled} onCheckedChange={(v) => onChange({ askEnabled: v })} />
        </Row>

        <div className="space-y-1 pt-2">
          <label htmlFor="ollama-model" className="text-sm font-medium">Ollama model</label>
          <select
            id="ollama-model"
            value={config.ollamaModel}
            onChange={(e) => onChange({ ollamaModel: e.target.value })}
            className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
          >
            {options.map((m) => (
              <option key={m} value={m}>{m}</option>
            ))}
          </select>
        </div>
        {modelsQuery.error && <QueryError message={`Could not load Ollama models: ${modelsQuery.error.message}`}
          onRetry={() => void modelsQuery.refetch()} retrying={modelsQuery.isFetching} retryLabel="Retry models" />}
        {modelsQuery.isSuccess && models.length === 0 && <p className="text-sm text-muted-foreground">No models installed. Install a model in Ollama, then test again.</p>}

        <div className="flex items-center justify-between gap-3 pt-2">
          <p role="status" className="flex items-center gap-1.5 text-xs text-muted-foreground">
            {modelsQuery.isFetching ? (
              <><Loader2 className="h-3.5 w-3.5 animate-spin" /> Checking…</>
            ) : reachable ? (
              <><CheckCircle2 className="h-3.5 w-3.5 text-emerald-400" /> Reachable — {models.length} model(s)</>
            ) : (
              <><XCircle className="h-3.5 w-3.5 text-destructive" /> Unreachable</>
            )}
          </p>
          <Button variant="outline" size="sm" onClick={() => modelsQuery.refetch()} disabled={modelsQuery.isFetching}>
            <Plug className="h-4 w-4" /> Test
          </Button>
        </div>

        <TextField label="Ollama base URL" value={config.ollamaBaseUrl} onChange={(v) => onChange({ ollamaBaseUrl: v })} />
        <div className="grid grid-cols-2 gap-2 pt-2">
          <NumberField
            label="Timeout (s)"
            value={config.ollamaTimeoutSeconds}
            min={5}
            onChange={(v) => onChange({ ollamaTimeoutSeconds: v })}
          />
          <TextField
            label="Keep-alive"
            hint='e.g. "5m", "-1" = forever'
            value={config.ollamaKeepAlive}
            onChange={(v) => onChange({ ollamaKeepAlive: v })}
          />
        </div>

        <TextAreaField
          label="Ask master prompt"
          hint="Steers the persona/bias of every bot.ask reply."
          value={config.askSystemPrompt}
          rows={5}
          onChange={(v) => onChange({ askSystemPrompt: v })}
          placeholder="System instructions applied to every bot.ask answer…"
        />

        <div className="mt-3 border-t border-input pt-2">
          <p className="pt-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Reddit (optional, for bot.tldr)</p>
          <TextField label="Client ID" value={config.redditClientId} placeholder="optional" onChange={(v) => onChange({ redditClientId: v })} />
          <TextField label="Client secret" type="password" value={config.redditClientSecret} placeholder="optional" onChange={(v) => onChange({ redditClientSecret: v })} />
          <TextField label="User agent" value={config.redditUserAgent} placeholder="whatsapp-bot/1.0" onChange={(v) => onChange({ redditUserAgent: v })} />
          <TextField label="Refresh token" type="password" value={config.redditRefreshToken} placeholder="optional" onChange={(v) => onChange({ redditRefreshToken: v })} />
        </div>
      </CardContent>
    </Card>
  );
}
