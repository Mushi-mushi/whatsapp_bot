import type { Handler } from "../../router/router.js";
import type { InteractionStore } from "../../state/interactions.js";
import { euros, MUTE_DEBT_CENTS_PER_MINUTE } from "../../router/pricing.js";
import { messagePerson } from "./local-target.js";

export function makeBilling(interactions: InteractionStore): Handler {
  return (ctx) => {
    const sender = messagePerson(ctx.msg);
    const count = interactions.total(sender);
    const cents = interactions.debt(sender);
    return ctx.reply([
      "*Your totally fake bot bill*",
      `Customer: ${ctx.msg.senderName}`,
      `Lifetime interactions across chats: ${count}`,
      `*Pretend total: ${euros(cents)}*`,
      `Mute allowance: ${Math.floor(cents / MUTE_DEBT_CENTS_PER_MINUTE)} whole minute(s).`,
      "Each mute minute removes EUR 1.00 of your debt. Prices vary by command; use bot.cost.",
      "",
      "Checking your bill is always free.",
      "Just for fun - no real charges, no payment due!",
    ].join("\n"));
  };
}
