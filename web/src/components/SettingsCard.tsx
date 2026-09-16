import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { useQuery } from "@tanstack/react-query";
import { api, type BotConfig } from "@/lib/api";

interface Props {
  config: BotConfig;
  onChange: (patch: Partial<BotConfig>) => void;
}

function Row({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 py-1.5">
      <div>
        <p className="text-sm font-medium">{label}</p>
        {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
      </div>
      {children}
    </div>
  );
}

export function SettingsCard({ config, onChange }: Props) {
  const modelsQuery = useQuery({ queryKey: ["ollama-models"], queryFn: api.getOllamaModels });
  const models = modelsQuery.data?.models ?? [];
  // Always include the currently-selected model so it stays visible even if Ollama is unreachable.
  const options = models.includes(config.ollamaModel)
    ? models
    : [config.ollamaModel, ...models].filter(Boolean);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Settings</CardTitle>
      </CardHeader>
      <CardContent className="space-y-1">
        <Row label="Audio transcription" hint="Transcribe voice notes via Auralis">
          <Switch
            checked={config.transcriptionEnabled}
            onCheckedChange={(v) => onChange({ transcriptionEnabled: v })}
          />
        </Row>
        <Row label="Download audio" hint="Required for transcription">
          <Switch
            checked={config.audioDownloadEnabled}
            onCheckedChange={(v) => onChange({ audioDownloadEnabled: v })}
          />
        </Row>
        <Row label="Acknowledge media" hint="Reply to images/stickers (off = ignore)">
          <Switch
            checked={config.acknowledgeMedia}
            onCheckedChange={(v) => onChange({ acknowledgeMedia: v })}
          />
        </Row>
        <Row label="Respond to my own commands" hint="Run bot.* from your linked phone">
          <Switch
            checked={config.respondToOwnCommands}
            onCheckedChange={(v) => onChange({ respondToOwnCommands: v })}
          />
        </Row>
        <Row label="AI ask (Ollama)" hint="Enable bot.ask via your local Ollama">
          <Switch
            checked={config.askEnabled}
            onCheckedChange={(v) => onChange({ askEnabled: v })}
          />
        </Row>

        <div className="space-y-1 pt-2">
          <p className="text-sm font-medium">Ollama model</p>
          <select
            value={config.ollamaModel}
            onChange={(e) => onChange({ ollamaModel: e.target.value })}
            className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
          >
            {options.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
          <p className="text-xs text-muted-foreground">
            {modelsQuery.isLoading
              ? "Loading models…"
              : models.length
                ? `${models.length} model(s) found on Ollama`
                : "Ollama unreachable — showing current model only"}
          </p>
        </div>
        <div className="space-y-1 pt-2">
          <p className="text-sm font-medium">Ollama base URL</p>
          <Input
            value={config.ollamaBaseUrl}
            onChange={(e) => onChange({ ollamaBaseUrl: e.target.value })}
          />
        </div>
        <div className="space-y-1 pt-2">
          <p className="text-sm font-medium">Ollama timeout (s)</p>
          <Input
            type="number"
            value={config.ollamaTimeoutSeconds}
            onChange={(e) => onChange({ ollamaTimeoutSeconds: Number(e.target.value) || 120 })}
          />
        </div>

        <div className="space-y-1 pt-2">
          <p className="text-sm font-medium">Auralis base URL</p>
          <Input
            value={config.auralisBaseUrl}
            onChange={(e) => onChange({ auralisBaseUrl: e.target.value })}
          />
        </div>
        <div className="space-y-1 pt-2">
          <p className="text-sm font-medium">Transcription timeout (s)</p>
          <Input
            type="number"
            value={config.transcriptionTimeoutSeconds}
            onChange={(e) => onChange({ transcriptionTimeoutSeconds: Number(e.target.value) || 90 })}
          />
        </div>
        <div className="space-y-1 pt-2">
          <p className="text-sm font-medium">Bot reply prefix</p>
          <Input
            value={config.botReplyPrefix}
            onChange={(e) => onChange({ botReplyPrefix: e.target.value })}
          />
        </div>
      </CardContent>
    </Card>
  );
}
