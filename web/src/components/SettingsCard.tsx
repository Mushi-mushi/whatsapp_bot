import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Button } from "@/components/ui/button";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
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
  const [triviaCleared, setTriviaCleared] = useState(false);
  const [triviaPending, setTriviaPending] = useState(false);
  const [triviaError, setTriviaError] = useState("");

  async function clearTrivia() {
    if (!window.confirm("Clear the trivia leaderboard for all chats? This can't be undone.")) return;
    setTriviaPending(true);
    setTriviaError("");
    setTriviaCleared(false);
    try {
      await api.resetTriviaScores();
      setTriviaCleared(true);
    } catch (error) {
      setTriviaError(error instanceof Error ? error.message : "Could not reset scores.");
    } finally {
      setTriviaPending(false);
    }
  }

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
        <Row label="Paint (image generation)" hint="Enable bot.paint via local ComfyUI">
          <Switch
            checked={config.paintEnabled}
            onCheckedChange={(v) => onChange({ paintEnabled: v })}
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
          <p className="text-sm font-medium">Paint backend URL (ComfyUI)</p>
          <Input
            value={config.paintBaseUrl}
            onChange={(e) => onChange({ paintBaseUrl: e.target.value })}
            placeholder="http://host.docker.internal:8188"
          />
          <p className="text-xs text-muted-foreground">ComfyUI API base (default port 8188)</p>
        </div>
        <div className="space-y-1 pt-2">
          <p className="text-sm font-medium">Paint checkpoint</p>
          <Input
            value={config.paintCheckpoint}
            onChange={(e) => onChange({ paintCheckpoint: e.target.value })}
            placeholder="DreamShaper_8_pruned.safetensors"
          />
        </div>
        <div className="space-y-1 pt-2">
          <p className="text-sm font-medium">Flux checkpoint</p>
          <Input
            value={config.paintFluxCheckpoint}
            onChange={(e) => onChange({ paintFluxCheckpoint: e.target.value })}
            placeholder="flux1-dev-fp8.safetensors"
          />
          <p className="text-xs text-muted-foreground">Used when a prompt includes the `flux` keyword (better at complex scenes).</p>
        </div>
        <div className="grid grid-cols-2 gap-2 pt-2">
          <div className="space-y-1">
            <p className="text-sm font-medium">Sampler</p>
            <Input
              value={config.paintSampler}
              onChange={(e) => onChange({ paintSampler: e.target.value })}
              placeholder="euler"
            />
          </div>
          <div className="space-y-1">
            <p className="text-sm font-medium">Scheduler</p>
            <Input
              value={config.paintScheduler}
              onChange={(e) => onChange({ paintScheduler: e.target.value })}
              placeholder="normal"
            />
          </div>
        </div>
        <div className="grid grid-cols-2 gap-2 pt-2">
          <div className="space-y-1">
            <p className="text-sm font-medium">Paint steps</p>
            <Input
              type="number"
              value={config.paintSteps}
              onChange={(e) => onChange({ paintSteps: Number(e.target.value) || 24 })}
            />
          </div>
          <div className="space-y-1">
            <p className="text-sm font-medium">CFG scale</p>
            <Input
              type="number"
              value={config.paintCfgScale}
              onChange={(e) => onChange({ paintCfgScale: Number(e.target.value) || 7 })}
            />
          </div>
        </div>
        <div className="grid grid-cols-2 gap-2 pt-2">
          <div className="space-y-1">
            <p className="text-sm font-medium">Width</p>
            <Input
              type="number"
              value={config.paintWidth}
              onChange={(e) => onChange({ paintWidth: Number(e.target.value) || 768 })}
            />
          </div>
          <div className="space-y-1">
            <p className="text-sm font-medium">Height</p>
            <Input
              type="number"
              value={config.paintHeight}
              onChange={(e) => onChange({ paintHeight: Number(e.target.value) || 768 })}
            />
          </div>
        </div>
        <div className="space-y-1 pt-2">
          <p className="text-sm font-medium">Paint negative prompt</p>
          <textarea
            value={config.paintNegativePrompt}
            onChange={(e) => onChange({ paintNegativePrompt: e.target.value })}
            rows={3}
            className="min-h-[72px] w-full resize-y rounded-md border border-input bg-background px-3 py-2 text-sm"
            placeholder="optional negative prompt"
          />
        </div>
        <div className="space-y-1 pt-2">
          <p className="text-sm font-medium">Paint denoise (img2img strength)</p>
          <Input
            type="number"
            value={config.paintDenoise}
            onChange={(e) => onChange({ paintDenoise: Number(e.target.value) || 0.6 })}
          />
          <p className="text-xs text-muted-foreground">0.1 keeps the photo, 1.0 fully repaints it (used when a photo is sent).</p>
        </div>
        <div className="space-y-1 pt-2">
          <p className="text-sm font-medium">Paint guidance (Flux edit strength)</p>
          <Input
            type="number"
            value={config.paintGuidance}
            onChange={(e) => onChange({ paintGuidance: Number(e.target.value) || 3.5 })}
          />
          <p className="text-xs text-muted-foreground">Used for reply-to-photo edits: ~2.5 is subtle, ~3.5–4 restyles boldly (e.g. Picasso/Monet).</p>
        </div>
        <div className="space-y-1 pt-2">
          <p className="text-sm font-medium">Ask master prompt</p>
          <textarea
            value={config.askSystemPrompt}
            onChange={(e) => onChange({ askSystemPrompt: e.target.value })}
            rows={5}
            className="min-h-[96px] w-full resize-y rounded-md border border-input bg-background px-3 py-2 text-sm"
            placeholder="System instructions applied to every bot.ask answer…"
          />
          <p className="text-xs text-muted-foreground">Steers the persona/bias of every bot.ask reply.</p>
        </div>

        <div className="space-y-1 pt-2">
          <p className="text-sm font-medium">Reddit client ID</p>
          <Input
            value={config.redditClientId}
            onChange={(e) => onChange({ redditClientId: e.target.value })}
            placeholder="optional"
          />
        </div>
        <div className="space-y-1 pt-2">
          <p className="text-sm font-medium">Reddit client secret</p>
          <Input
            type="password"
            value={config.redditClientSecret}
            onChange={(e) => onChange({ redditClientSecret: e.target.value })}
            placeholder="optional"
          />
        </div>
        <div className="space-y-1 pt-2">
          <p className="text-sm font-medium">Reddit user agent</p>
          <Input
            value={config.redditUserAgent}
            onChange={(e) => onChange({ redditUserAgent: e.target.value })}
            placeholder="whatsapp-bot/1.0"
          />
        </div>
        <div className="space-y-1 pt-2">
          <p className="text-sm font-medium">Reddit refresh token</p>
          <Input
            type="password"
            value={config.redditRefreshToken}
            onChange={(e) => onChange({ redditRefreshToken: e.target.value })}
            placeholder="optional"
          />
          <p className="text-xs text-muted-foreground">
            Stored in bot config; used for authenticated Reddit fetching when enabled.
          </p>
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

        <div className="flex items-center justify-between gap-4 border-t border-input pt-3">
          <div>
            <p className="text-sm font-medium">Trivia leaderboard</p>
            <p className="text-xs text-muted-foreground">Reset all trivia scores across chats.</p>
          </div>
          <Button variant="outline" onClick={clearTrivia} disabled={triviaPending}>
            {triviaCleared ? "Cleared ✓" : "Clear scores"}
          </Button>
        </div>
        {triviaError && <p role="alert" className="text-sm text-destructive">{triviaError}</p>}
      </CardContent>
    </Card>
  );
}
