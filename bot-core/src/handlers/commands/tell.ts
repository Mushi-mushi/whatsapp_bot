import type { Handler } from "../../router/router.js";
import type { SeenActivityStore, TellStore } from "../../state/repos.js";
import { localTarget } from "./local-target.js";
import { chatKey } from "./user-context.js";

// bot.tell <name>: <message>  (colon separates a multi-word name from the message;
// without a colon, the first word is taken as the name).
export function makeTell(tells: TellStore, people: SeenActivityStore): Handler {
  return (ctx) => {
    const raw = ctx.args.trim();
    if (!raw) {
      return ctx.reply("Usage: `bot.tell Alice: call me back` — I'll pass it on when they're next active.");
    }

    let name: string;
    let message: string;
    const colon = raw.indexOf(":");
    if (colon > 0) {
      name = raw.slice(0, colon).trim();
      message = raw.slice(colon + 1).trim();
    } else {
      const sp = raw.indexOf(" ");
      if (sp < 0) {
        return ctx.reply("What should I tell them? Usage: `bot.tell Alice: call me back`");
      }
      name = raw.slice(0, sp).trim();
      message = raw.slice(sp + 1).trim();
    }

    if (!name || !message) {
      return ctx.reply("Usage: `bot.tell Alice: call me back`");
    }
    const target = localTarget(people, ctx.msg, name);
    if ("error" in target) return ctx.reply(target.error);
    tells.add(chatKey(ctx.msg), target.person.sender_id, target.person.name, ctx.msg.senderName, message);
    return ctx.reply(`Got it — I'll tell ${target.person.name} next time they're active in this chat. 📨`);
  };
}
