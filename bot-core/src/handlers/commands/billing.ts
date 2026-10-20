import type { Handler } from "../../router/router.js";
import type { InteractionStore } from "../../state/interactions.js";
import type { SeenActivityStore } from "../../state/repos.js";
import { euros, MUTE_DEBT_CENTS_PER_MINUTE } from "../../router/pricing.js";
import { localTarget, messagePerson } from "./local-target.js";

export function makeBilling(interactions: InteractionStore, people: SeenActivityStore): Handler {
  return (ctx) => {
    let sender = messagePerson(ctx.msg);
    let name = ctx.msg.senderName;
    const target = ctx.args.trim();
    if (target) {
      const resolved = localTarget(people, ctx.msg, target);
      if ("error" in resolved) return ctx.reply(resolved.error);
      sender = resolved.person.sender_id;
      name = resolved.person.name;
    }
    const count = interactions.total(sender);
    const cents = interactions.debt(sender);
    return ctx.reply([
      "*Totally fake bot bill*",
      `Customer: ${name}`,
      `Lifetime interactions across chats: ${count}`,
      `*Pretend total: ${euros(cents)}*`,
      `Mute allowance: ${Math.floor(cents / MUTE_DEBT_CENTS_PER_MINUTE)} whole minute(s).`,
      "Each mute minute removes EUR 1.00 of the customer's debt. Prices vary by command; use bot.cost.",
      "",
      "Checking bills is always free.",
      "Just for fun - no real charges, no payment due!",
    ].join("\n"));
  };
}
