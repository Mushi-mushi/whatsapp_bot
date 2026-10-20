import type { Handler } from "../../router/router.js";
import { getCommandDefinition } from "../../router/commands.js";
import { costDescription } from "../../router/pricing.js";

export const cost: Handler = (ctx) => {
  const prices = Object.entries(ctx.config.commands)
    .filter(([, id]) => getCommandDefinition(id))
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([trigger, id]) => `- \`${trigger}\`: ${costDescription(id)}`);
  return ctx.reply([
    "*Pretend bot prices*",
    ...prices,
    "",
    "Prices add fake debt, not spendable credit. No real payment!",
    "Each EUR 1.00 owed allows one whole minute of mute in an approved group.",
    "A successful mute removes EUR 1.00/minute from the target and adds EUR 0.20/minute to the caller.",
    "Existing mutes are extended; allowance comes from remaining debt across all chats.",
    "Billing and cost checks are free. Ordinary commands count at dispatch, even on failure/busy replies.",
    "Mute, siesta (including forced sleep) and trivia skips charge only when accepted; skips cost EUR 0.20 total, not an extra fee.",
  ].join("\n"));
};
