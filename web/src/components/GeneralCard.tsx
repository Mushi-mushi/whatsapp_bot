import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { X } from "lucide-react";
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
  const [instaTarget, setInstaTarget] = useState("");

  function addInstaTarget() {
    const value = instaTarget.trim();
    if (!value) return;
    const exists = config.instagramDeleteSenders.some(
      (t) => t.trim().toLowerCase() === value.toLowerCase(),
    );
    if (!exists) onChange({ instagramDeleteSenders: [...config.instagramDeleteSenders, value] });
    setInstaTarget("");
  }

  function removeInstaTarget(index: number) {
    onChange({
      instagramDeleteSenders: config.instagramDeleteSenders.filter((_, i) => i !== index),
    });
  }

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
        <Row label="Delete Instagram posts" hint="Auto-delete Instagram links (bot must be group admin)">
          <Switch checked={config.deleteInstagramPosts} onCheckedChange={(v) => onChange({ deleteInstagramPosts: v })} />
        </Row>
        {config.deleteInstagramPosts && (
          <div className="rounded-lg border border-input bg-background/40 p-3">
            <p className="text-sm font-medium">Delete only from these users</p>
            <p className="mb-2 text-xs text-muted-foreground">
              Phone number or name. Leave empty to delete everyone's Instagram posts.
            </p>
            <div className="mb-2 flex flex-wrap gap-2">
              {config.instagramDeleteSenders.length === 0 && (
                <span className="text-xs text-muted-foreground">Applies to everyone.</span>
              )}
              {config.instagramDeleteSenders.map((t, i) => (
                <span
                  key={`${t}-${i}`}
                  className="inline-flex max-w-full items-center gap-1.5 rounded-full border border-primary/20 bg-primary/10 py-1 pl-3 pr-1.5 text-sm"
                >
                  <span className="truncate">{t}</span>
                  <button
                    onClick={() => removeInstaTarget(i)}
                    className="grid h-5 w-5 shrink-0 place-items-center rounded-full text-muted-foreground transition hover:bg-destructive/15 hover:text-destructive"
                    aria-label={`Remove ${t}`}
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </span>
              ))}
            </div>
            <div className="flex gap-2">
              <Input
                placeholder="Phone number or name…"
                value={instaTarget}
                onChange={(e) => setInstaTarget(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    addInstaTarget();
                  }
                }}
              />
              <Button variant="outline" onClick={addInstaTarget} disabled={!instaTarget.trim()}>
                Add
              </Button>
            </div>
          </div>
        )}
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
