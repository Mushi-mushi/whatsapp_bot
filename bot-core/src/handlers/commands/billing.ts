import type { Handler } from "../../router/router.js";
import type { InteractionStore } from "../../state/interactions.js";

export function makeBilling(interactions: InteractionStore): Handler {
  return (ctx) => {
    const count = interactions.total(ctx.msg.senderId, ctx.msg.senderPhone);
    const cents = count * 10;
    const total = `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, "0")}`;
    return ctx.reply([
      "*Your totally fake bot bill*",
      `Customer: ${ctx.msg.senderName}`,
      `Lifetime interactions across chats: ${count}`,
      "Rate: EUR 0.10 per interaction",
      `*Pretend total: EUR ${total}*`,
      "",
      "Checking your bill is always free.",
      "Just for fun - no real charges, no payment due!",
    ].join("\n"));
  };
}
