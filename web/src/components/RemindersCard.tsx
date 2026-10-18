import type { ChatIdentity } from "@/lib/api";
import { ScheduledMessagesCard } from "./ScheduledMessagesCard";

export function RemindersCard({ chats = [] }: { chats?: ChatIdentity[] }) {
  return <ScheduledMessagesCard kind="reminders" chats={chats} />;
}
