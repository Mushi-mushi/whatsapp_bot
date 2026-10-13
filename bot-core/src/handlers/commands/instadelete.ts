import type { Handler } from "../../router/router.js";
import type { ConfigController } from "../../config/controller.js";
import type { BotConfig } from "../../config/schema.js";
import type { IncomingMessage } from "../../transport/types.js";
import { normalizeName } from "../../router/normalize.js";

const ON = new Set(["on", "enable", "enabled", "yes", "true", "1"]);
const OFF = new Set(["off", "disable", "disabled", "no", "false", "0"]);
const REMOVE = new Set(["remove", "rm", "del", "delete"]);

const USAGE = "Try `bot.instadelete on|off|status|list|add <who>|remove <who>|clear`.";

// Two target strings refer to the same person if equal, same phone digits, or same name.
function sameTarget(a: string, b: string): boolean {
  const na = a.trim();
  const nb = b.trim();
  if (na.toLowerCase() === nb.toLowerCase()) return true;
  const da = na.replace(/\D/g, "");
  const db = nb.replace(/\D/g, "");
  if (da.length >= 6 && da === db) return true;
  const name = normalizeName(na);
  return name !== "" && name === normalizeName(nb);
}

// The sender of the message this command replies to (for `bot.instadelete add`).
function quotedParticipant(msg: IncomingMessage): string | null {
  const ctxInfo = msg.raw.message?.extendedTextMessage?.contextInfo as
    | { participant?: string | null }
    | undefined;
  return ctxInfo?.participant ?? null;
}

// bot.instadelete [on|off|status|list|add <who>|remove <who>|clear]. Owner only
// (it mutates global config). `add`/`remove` target specific senders (phone, name,
// or reply to their message); an empty target list means "everyone". Deletion
// itself needs admin rights in groups.
export function makeInstaDelete(settings: ConfigController): Handler {
  return (ctx) => {
    if (!ctx.msg.fromMe) {
      return ctx.reply("Only the bot owner can change Instagram auto-delete. Use the dashboard or ask them.");
    }
    const trimmed = ctx.args.trim();
    const sub = (trimmed.split(/\s+/)[0] ?? "").toLowerCase();
    const rest = trimmed.slice(sub.length).trim();
    const cfg = settings.get();
    const targets = cfg.instagramDeleteSenders;
    const scope = targets.length ? `${targets.length} targeted user(s)` : "everyone";

    if (!sub || sub === "status") {
      return ctx.reply(
        `Instagram auto-delete is *${cfg.deleteInstagramPosts ? "ON" : "OFF"}* for ${scope}. ` +
          "Manage with `bot.instadelete on|off|add <who>|remove <who>|list`. " +
          "(I can only delete for everyone in groups where I'm an admin.)",
      );
    }

    if (ON.has(sub)) {
      if (cfg.deleteInstagramPosts) return ctx.reply(`Instagram auto-delete is already *ON* for ${scope}.`);
      settings.update({ deleteInstagramPosts: true });
      return ctx.reply(`Instagram auto-delete is now *ON* for ${scope} (needs admin rights in groups).`);
    }
    if (OFF.has(sub)) {
      if (!cfg.deleteInstagramPosts) return ctx.reply("Instagram auto-delete is already *OFF*.");
      settings.update({ deleteInstagramPosts: false });
      return ctx.reply("Instagram auto-delete is now *OFF*.");
    }

    if (sub === "list") {
      if (!targets.length) {
        return ctx.reply(
          "No targeted users — Instagram deletion applies to *everyone* (when ON). " +
            "Add one with `bot.instadelete add <phone or name>`.",
        );
      }
      return ctx.reply(`Deleting Instagram posts from:\n${targets.map((t) => `• ${t}`).join("\n")}`);
    }

    if (sub === "add") {
      const who = rest || quotedParticipant(ctx.msg);
      if (!who) {
        return ctx.reply(
          "Who? Use `bot.instadelete add <phone or name>`, or reply to their message with `bot.instadelete add`.",
        );
      }
      const already = targets.some((t) => sameTarget(t, who));
      const patch: Partial<BotConfig> = {};
      if (!already) patch.instagramDeleteSenders = [...targets, who];
      if (!cfg.deleteInstagramPosts) patch.deleteInstagramPosts = true;
      if (Object.keys(patch).length === 0) {
        return ctx.reply(`\`${who}\` is already targeted and auto-delete is *ON*.`);
      }
      settings.update(patch);
      const enabledNote = patch.deleteInstagramPosts ? " Auto-delete is now *ON*." : "";
      return ctx.reply(
        (already
          ? `\`${who}\` is already targeted.`
          : `Now deleting Instagram posts from \`${who}\`.`) +
          `${enabledNote} (I need admin rights in groups to delete others' messages.)`,
      );
    }

    if (REMOVE.has(sub)) {
      const who = rest || quotedParticipant(ctx.msg);
      if (!who) return ctx.reply("Who? Use `bot.instadelete remove <phone or name>`.");
      const next = targets.filter((t) => !sameTarget(t, who));
      if (next.length === targets.length) return ctx.reply(`\`${who}\` wasn't in the list.`);
      settings.update({ instagramDeleteSenders: next });
      return ctx.reply(`No longer targeting \`${who}\`.`);
    }

    if (sub === "clear") {
      if (!targets.length) return ctx.reply("The targeted-users list is already empty.");
      settings.update({ instagramDeleteSenders: [] });
      return ctx.reply("Cleared the list. Instagram deletion now applies to *everyone* (when ON).");
    }

    return ctx.reply(USAGE);
  };
}
