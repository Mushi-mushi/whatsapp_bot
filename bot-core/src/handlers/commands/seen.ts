import type { Handler } from "../../router/router.js";
import type { SeenActivityStore } from "../../state/repos.js";
import { normalizeName } from "../../router/normalize.js";
import { timeAgo } from "../../util/time.js";

export function makeSeen(seen: SeenActivityStore): Handler {
  return (ctx) => {
    const target = ctx.args.trim();
    if (!target) {
      return ctx.reply("Who are you looking for? Usage: `bot.seen Alice`");
    }
    if (normalizeName(target) === normalizeName(ctx.msg.senderName)) {
      return ctx.reply("You're right here! 👀");
    }
    const rec = seen.get(normalizeName(target));
    if (!rec) {
      return ctx.reply(`I haven't seen "${target}" say anything yet.`);
    }
    const where = rec.chat_name ? ` in ${rec.chat_name}` : "";
    return ctx.reply(`${rec.name} was last seen ${timeAgo(rec.last_ts)}${where}.`);
  };
}
