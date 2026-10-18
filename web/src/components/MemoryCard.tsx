import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import type { BotConfig } from "@/lib/api";
import { Row, NumberField } from "@/components/fields";

interface Props {
  config: BotConfig;
  onChange: (patch: Partial<BotConfig>) => void;
}

export function MemoryCard({ config, onChange }: Props) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Memory & profiles</CardTitle>
        <CardDescription>
          The bot learns separately in each chat to personalise bot.ask and bot.profile. Requires AI (Ollama) enabled in AI.
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
            hint="Rolling history per person in each chat"
            value={config.userMemoryLimit}
            min={5} max={500}
            onChange={(v) => onChange({ userMemoryLimit: v })}
          />
          <NumberField
            label="Fallback context"
            hint="Raw msgs used before a profile exists"
            value={config.userMemoryContext}
            min={1} max={100}
            onChange={(v) => onChange({ userMemoryContext: v })}
          />
        </div>

        <div className="grid grid-cols-2 gap-2 pt-2">
          <NumberField
            label="Rebuild every (msgs)"
            hint="New messages before a refresh"
            value={config.profileRefreshEvery}
            min={1}
            onChange={(v) => onChange({ profileRefreshEvery: v })}
          />
          <NumberField
            label="Rebuild every (days)"
            hint="Max age before a refresh"
            value={config.profileMaxAgeDays}
            min={1}
            onChange={(v) => onChange({ profileMaxAgeDays: v })}
          />
        </div>

        <div className="grid grid-cols-2 gap-2 pt-2">
          <NumberField
            label="Deep sample size"
            hint="Messages fed to the dossier builder"
            value={config.profileSampleSize}
            min={5} max={200}
            onChange={(v) => onChange({ profileSampleSize: v })}
          />
          <NumberField
            label="Briefing length"
            hint="Max chars injected into bot.ask"
            value={config.profileShortMaxChars}
            min={100} max={1000}
            onChange={(v) => onChange({ profileShortMaxChars: v })}
          />
        </div>
      </CardContent>
    </Card>
  );
}
