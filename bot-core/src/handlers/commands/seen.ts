import type { Handler } from "../../router/router.js";
import type { SeenActivityStore } from "../../state/repos.js";
import { timeAgo } from "../../util/time.js";
import { localTarget, messagePerson } from "./local-target.js";

export function makeSeen(seen: SeenActivityStore): Handler {
  return (ctx) => {
    const target = ctx.args.trim();
    if (!target) {
      return ctx.reply("Who are you looking for? Usage: `bot.seen Alice`");
    }
    const resolved = localTarget(seen, ctx.msg, target);
    if ("error" in resolved) return ctx.reply(resolved.error);
    if (resolved.person.sender_id === seen.canonical(messagePerson(ctx.msg))) {
      return ctx.reply("You're right here! 👀");
    }
    const rec = resolved.person;
    const where = rec.chat_name ? ` in ${rec.chat_name}` : "";
    return ctx.reply(`${rec.name} was last seen ${timeAgo(rec.last_ts)}${where}.`);
  };
}
