import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { Row } from "@/components/fields";
import { Input } from "@/components/ui/input";
import type { BotConfig, ChatIdentity } from "@/lib/api";

interface Props {
  config: BotConfig;
  chats: ChatIdentity[];
  onChange: (patch: Partial<BotConfig>) => void;
}

export function AchievementsCard({ config, chats, onChange }: Props) {
  const approved = config.approvedSenders.filter((chat) => chat.includes("@") || /^\+?[\d ()-]+$/.test(chat));
  return (
    <Card>
      <CardHeader>
        <CardTitle>Achievements</CardTitle>
        <CardDescription>
          Opt in each approved chat, then Save changes. Progress is separate per person and chat.
          Enabling announces achievements in that chat.
          Disabling pauses progress without deleting badges; removing approval also disables achievements.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-2">
        <Row label="Achievement timezone" hint="IANA timezone for calendar days and night-time activity.">
          <Input aria-label="Achievement timezone" value={config.achievementTimezone}
            onChange={(event) => onChange({ achievementTimezone: event.target.value })} />
        </Row>
        {approved.length === 0 && <p className="text-sm text-muted-foreground">Approve a chat above to enable achievements.</p>}
        {approved.map((chat) => (
          <Row key={chat} label={chats.find((entry) => entry.id === chat)?.name ?? chat} hint={chat}>
            <Switch
              aria-label={`Achievements for ${chat}`}
              checked={config.achievementChats.includes(chat)}
              onCheckedChange={(enabled) => onChange({
                achievementChats: enabled
                  ? [...new Set([...config.achievementChats, chat])]
                  : config.achievementChats.filter((entry) => entry !== chat),
              })}
            />
          </Row>
        ))}
        <p className="text-sm text-muted-foreground">
          Starts counting from activation, with unlock announcements in that chat.
          Use bot.achievements to see badges for messages, commands, trivia, duel wins,
          returning after 1/7/30 days quiet, and sending 5/10/25 messages in a row.
          Additional surprise achievements stay hidden until earned.
        </p>
      </CardContent>
    </Card>
  );
}
