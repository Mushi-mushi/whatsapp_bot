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

export function PaintCard({ config, onChange }: Props) {
  const statusQuery = useQuery({ queryKey: ["comfyui-status"], queryFn: api.getComfyStatus });
  const reachable = statusQuery.data?.reachable ?? false;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Paint &amp; Film (ComfyUI)</CardTitle>
        <CardDescription>Local image/video generation for bot.paint and bot.film.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-1">
        <Row label="Paint" hint="Enable bot.paint / bot.film via local ComfyUI">
          <Switch checked={config.paintEnabled} onCheckedChange={(v) => onChange({ paintEnabled: v })} />
        </Row>

        <TextField
          label="Backend URL (ComfyUI)"
          hint="ComfyUI API base (default port 8188)"
          value={config.paintBaseUrl}
          placeholder="http://host.docker.internal:8188"
          onChange={(v) => onChange({ paintBaseUrl: v })}
        />
        <div className="flex items-center justify-between gap-3 pt-2">
          <p role="status" className="flex items-center gap-1.5 text-xs text-muted-foreground">
            {statusQuery.isFetching ? (
              <><Loader2 className="h-3.5 w-3.5 animate-spin" /> Checking…</>
            ) : reachable ? (
              <><CheckCircle2 className="h-3.5 w-3.5 text-emerald-400" /> Reachable{statusQuery.data?.version ? ` — v${statusQuery.data.version}` : ""}</>
            ) : (
              <><XCircle className="h-3.5 w-3.5 text-destructive" /> Unreachable</>
            )}
          </p>
          <Button variant="outline" size="sm" onClick={() => statusQuery.refetch()} disabled={statusQuery.isFetching}>
            <Plug className="h-4 w-4" /> Test
          </Button>
        </div>
        {statusQuery.error && <QueryError message={`ComfyUI status unavailable: ${statusQuery.error.message}`}
          onRetry={() => void statusQuery.refetch()} retrying={statusQuery.isFetching} retryLabel="Retry ComfyUI status" />}

        <p className="pt-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Checkpoints</p>
        <TextField
          label="Default checkpoint (SDXL)"
          value={config.paintCheckpoint}
          placeholder="RealVisXL_V4.0.safetensors"
          onChange={(v) => onChange({ paintCheckpoint: v })}
        />
        <TextField
          label="Flux checkpoint"
          hint="Used when a prompt includes the `flux` keyword"
          value={config.paintFluxCheckpoint}
          placeholder="flux1-dev-fp8.safetensors"
          onChange={(v) => onChange({ paintFluxCheckpoint: v })}
        />

        <p className="pt-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Sampling</p>
        <div className="grid grid-cols-2 gap-2 pt-1">
          <TextField label="Sampler" value={config.paintSampler} placeholder="euler" onChange={(v) => onChange({ paintSampler: v })} />
          <TextField label="Scheduler" value={config.paintScheduler} placeholder="normal" onChange={(v) => onChange({ paintScheduler: v })} />
        </div>
        <div className="grid grid-cols-2 gap-2 pt-2">
          <NumberField label="Steps" value={config.paintSteps} min={1} max={150} onChange={(v) => onChange({ paintSteps: v })} />
          <NumberField label="CFG scale" value={config.paintCfgScale} min={1} max={30} step="any" onChange={(v) => onChange({ paintCfgScale: v })} />
        </div>

        <p className="pt-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Dimensions</p>
        <div className="grid grid-cols-2 gap-2 pt-1">
          <NumberField label="Width" value={config.paintWidth} min={256} max={2048} onChange={(v) => onChange({ paintWidth: v })} />
          <NumberField label="Height" value={config.paintHeight} min={256} max={2048} onChange={(v) => onChange({ paintHeight: v })} />
        </div>

        <p className="pt-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Image-to-image</p>
        <div className="grid grid-cols-2 gap-2 pt-1">
          <NumberField
            label="Denoise"
            hint="0.1 keeps photo, 1.0 repaints"
            value={config.paintDenoise}
            min={0.1} max={1} step="any"
            onChange={(v) => onChange({ paintDenoise: v })}
          />
          <NumberField
            label="Flux guidance"
            hint="~2.5 subtle, 3.5–4 bold"
            value={config.paintGuidance}
            min={1} max={10} step="any"
            onChange={(v) => onChange({ paintGuidance: v })}
          />
        </div>

        <TextAreaField
          label="Negative prompt"
          value={config.paintNegativePrompt}
          rows={3}
          placeholder="optional negative prompt"
          onChange={(v) => onChange({ paintNegativePrompt: v })}
        />
      </CardContent>
    </Card>
  );
}
