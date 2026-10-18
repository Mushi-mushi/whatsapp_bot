import type { Handler } from "../../router/router.js";
import { senderKey } from "./user-context.js";
import { personKey } from "../../state/identity.js";

// bot.whoami — echo how the bot identifies the sender: the display name it uses,
// the stable identity key behind it, and whether they're recognized as the owner.
export const whoami: Handler = (ctx) => {
  const name = ctx.msg.senderName?.trim() || "(unknown)";
  const lines = [
    `🪪 You are *${name}*`,
    `• Identity key: ${personKey(ctx.msg.senderId, ctx.msg.senderPhone)}`,
    `• Chat ID: ${ctx.msg.chatId}`,
    `• Chat memory key: ${senderKey(ctx.msg)}`,
    `• Owner: ${ctx.msg.fromMe ? "yes" : "no"}`,
    `• Use \`bot.seen ${name}\` to let others look you up.`,
  ];
  return ctx.reply(lines.join("\n"));
};
