import type { Handler } from "../../router/router.js";
import type { InteractionStore } from "../../state/interactions.js";
import type { SeenActivityStore } from "../../state/repos.js";
import { localTarget, messagePerson } from "./local-target.js";
import { chatKey } from "./user-context.js";
import { euros, MUTE_COST_CENTS_PER_MINUTE, MUTE_DEBT_CENTS_PER_MINUTE } from "../../router/pricing.js";

export function makeMute(interactions: InteractionStore, people: SeenActivityStore): Handler {
  return async (ctx) => {
    if (!ctx.msg.isGroup) return ctx.reply("Mute only works in approved groups.");
    const match = /^(.+?)\s+([1-9]\d*)$/.exec(ctx.args.trim());
    const minutes = match ? Number(match[2]) : NaN;
    if (!match || !Number.isSafeInteger(minutes * 60_000 + Date.now())) {
      return ctx.reply(`Usage: \`${ctx.commandTrigger ?? "bot.mute"} <name> <minutes>\`. Use a positive whole number of minutes.`);
    }
    const resolved = localTarget(people, ctx.msg, match[1]);
    if ("error" in resolved) return ctx.reply(resolved.error);
    const target = resolved.person;
    let admin: boolean;
    try {
      admin = await ctx.isBotGroupAdmin();
    } catch {
      return ctx.reply("I couldn't verify my group-admin rights. No mute or charge applied; try again when WhatsApp is connected.");
    }
    if (!admin) return ctx.reply("Make me a group admin before using mute. No charge applied.");
    const caller = people.canonical(messagePerson(ctx.msg));
    const targetId = people.canonical(target.sender_id);
    if (targetId === caller) return ctx.reply("You cannot mute yourself.");
    const owner = ctx.connection.me;
    if (owner && targetId === people.canonical(owner)) {
      return ctx.reply("The bot's linked account cannot be muted.");
    }
    const result = interactions.mute(chatKey(ctx.msg), caller, targetId, minutes);
    if (!result.ok) {
      return ctx.reply(`${target.name} has only ${result.allowance} whole minute(s) of mute allowance. No charge applied.`);
    }
    return ctx.reply(`${target.name} is muted until ${new Date(result.until).toISOString()}. ` +
      `${minutes} minute(s) added; ${euros(minutes * MUTE_DEBT_CENTS_PER_MINUTE)} removed from their fake debt, ` +
      `${euros(minutes * MUTE_COST_CENTS_PER_MINUTE)} added to yours. Messages will be auto-deleted; they may briefly appear.`);
  };
}
