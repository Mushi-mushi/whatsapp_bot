import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import type { BotConfig } from "@/lib/api";

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

function NumberField({
  label,
  hint,
  value,
  fallback,
  onChange,
}: {
  label: string;
  hint?: string;
  value: number;
  fallback: number;
  onChange: (v: number) => void;
}) {
  return (
    <div className="space-y-1">
      <p className="text-sm font-medium">{label}</p>
      <Input type="number" value={value} onChange={(e) => onChange(Number(e.target.value) || fallback)} />
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

export function MemoryCard({ config, onChange }: Props) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Memory & profiles</CardTitle>
        <CardDescription>
          The bot passively learns from chat to personalise bot.ask and bot.profile. Requires AI (Ollama) enabled in Settings.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-1">
        <Row label="User memory" hint="Remember what people say (off = learn nothing)">
          <Switch
            checked={config.userMemoryEnabled}
            onCheckedChange={(v) => onChange({ userMemoryEnabled: v })}
          />
        </Row>

        <div className="grid grid-cols-2 gap-2 pt-2">
          <NumberField
            label="Messages kept / user"
            hint="Rolling history size"
            value={config.userMemoryLimit}
            fallback={50}
            onChange={(v) => onChange({ userMemoryLimit: v })}
          />
          <NumberField
            label="Fallback context"
            hint="Raw msgs used before a profile exists"
            value={config.userMemoryContext}
            fallback={20}
            onChange={(v) => onChange({ userMemoryContext: v })}
          />
        </div>

        <div className="grid grid-cols-2 gap-2 pt-2">
          <NumberField
            label="Rebuild every (msgs)"
            hint="New messages before a refresh"
            value={config.profileRefreshEvery}
            fallback={25}
            onChange={(v) => onChange({ profileRefreshEvery: v })}
          />
          <NumberField
            label="Rebuild every (days)"
            hint="Max age before a refresh"
            value={config.profileMaxAgeDays}
            fallback={7}
            onChange={(v) => onChange({ profileMaxAgeDays: v })}
          />
        </div>

        <div className="grid grid-cols-2 gap-2 pt-2">
          <NumberField
            label="Deep sample size"
            hint="Messages fed to the dossier builder"
            value={config.profileSampleSize}
            fallback={50}
            onChange={(v) => onChange({ profileSampleSize: v })}
          />
          <NumberField
            label="Briefing length"
            hint="Max chars injected into bot.ask"
            value={config.profileShortMaxChars}
            fallback={400}
            onChange={(v) => onChange({ profileShortMaxChars: v })}
          />
        </div>
      </CardContent>
    </Card>
  );
}
