import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { Button } from "@/components/ui/button";
import { api, type BotConfig } from "@/lib/api";
import { Row, TextField, NumberField } from "@/components/fields";

interface Props {
  config: BotConfig;
  onChange: (patch: Partial<BotConfig>) => void;
}

export function GeneralCard({ config, onChange }: Props) {
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
        <CardTitle>General</CardTitle>
      </CardHeader>
      <CardContent className="space-y-1">
        <Row label="Audio transcription" hint="Transcribe voice notes via Auralis">
          <Switch checked={config.transcriptionEnabled} onCheckedChange={(v) => onChange({ transcriptionEnabled: v })} />
        </Row>
        <Row label="Download audio" hint="Required for transcription">
          <Switch checked={config.audioDownloadEnabled} onCheckedChange={(v) => onChange({ audioDownloadEnabled: v })} />
        </Row>
        <Row label="Acknowledge media" hint="Reply to images/stickers (off = ignore)">
          <Switch checked={config.acknowledgeMedia} onCheckedChange={(v) => onChange({ acknowledgeMedia: v })} />
        </Row>
        <Row label="Respond to my own commands" hint="Run bot.* from your linked phone">
          <Switch checked={config.respondToOwnCommands} onCheckedChange={(v) => onChange({ respondToOwnCommands: v })} />
        </Row>

        <TextField
          label="Bot reply prefix"
          hint="Prepended to every bot reply"
          value={config.botReplyPrefix}
          onChange={(v) => onChange({ botReplyPrefix: v })}
        />
        <TextField
          label="Auralis base URL"
          value={config.auralisBaseUrl}
          onChange={(v) => onChange({ auralisBaseUrl: v })}
        />
        <div className="grid grid-cols-2 gap-2 pt-2">
          <NumberField
            label="Transcription timeout (s)"
            value={config.transcriptionTimeoutSeconds}
            fallback={90}
            onChange={(v) => onChange({ transcriptionTimeoutSeconds: v })}
          />
        </div>

        <div className="mt-3 flex items-center justify-between gap-4 border-t border-input pt-3">
          <div>
            <p className="text-sm font-medium">Trivia leaderboard</p>
            <p className="text-xs text-muted-foreground">
              {triviaError || "Reset all trivia scores across chats."}
            </p>
          </div>
          <Button variant="outline" onClick={clearTrivia} disabled={triviaPending}>
            {triviaCleared ? "Cleared ✓" : "Clear scores"}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
