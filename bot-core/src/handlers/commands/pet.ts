import type { Handler } from "../../router/router.js";
import type { PetService } from "../../pets/service.js";
import { petPortrait } from "../../pets/art.js";
import { parsePetEnable, SPECIES_IDS } from "../../pets/model.js";
import type { AchievementStore } from "../../state/achievements.js";
import { messagePerson } from "./local-target.js";

const ADMIN_COMMANDS = new Set(["enable", "disable", "pause", "resume", "rename", "hours"]);
const COMMANDS = new Set(["", "status", "help", "species", "feed", "water", "clean", "play", "answer", "revive", ...ADMIN_COMMANDS]);
const HELP = [
  "A shared pet for this group, with original pictures and five evolving forms!",
  "bot.pet - portrait, stats, and evolution progress",
  "bot.pet feed | water | clean | play - care for your pet (separate one-hour cooldowns)",
  "bot.pet answer <answer> - answer a game or rescue riddle",
  "bot.pet revive - show the two-step rescue quest",
  "Owner/group admins: bot.pet enable [name] | disable | pause | resume | rename <name>",
  `Random species by default; choose with bot.pet enable Mochi species=fox. Species: ${SPECIES_IDS.join(", ")}.`,
  "Species is fixed for a pet's lifetime; re-enabling never rerolls it.",
  "bot.pet hours <start> <end> - waking hours, integer UTC hours 0-23 (overnight supported)",
  "Evolve at 1, 7, 21, and 60 healthy days. Request frequency and deadlines are configurable per group in the dashboard's Pets tab.",
  "Critical needs for 8 active hours cause hibernation; another 48 hours loses one form, once per episode.",
  "Rescue: leave a snack and solve the dream-riddle. One person can do both; no rescue expiry.",
  "Pausing, bot downtime, and lost group approval freeze progress and neglect. Silence is a game, never moderation.",
].join("\n");

export function makePet(pets: PetService, achievements?: AchievementStore): Handler {
  return async (ctx) => {
    if (!ctx.msg.isGroup) return ctx.reply("Pets live in groups, not direct messages.");
    if (!ctx.config.approvedSenders.includes(ctx.msg.chatId)) {
      return ctx.reply("Approve this group in the dashboard before enabling a pet.");
    }
    const trimmed = ctx.args.trim();
    const sub = (trimmed.split(/\s+/)[0] ?? "").toLowerCase();
    const rest = trimmed.slice(sub.length).trim();
    if (!COMMANDS.has(sub)) return ctx.reply("Unknown pet command. Use bot.pet help.");
    if (sub === "help") return ctx.reply(HELP);
    if (sub === "species") return ctx.reply(`Species: ${SPECIES_IDS.join(", ")}. Random by default; choose with bot.pet enable Mochi species=fox.`);
    if (ADMIN_COMMANDS.has(sub) && !ctx.msg.fromMe) {
      let admin: boolean;
      try {
        admin = await ctx.isGroupAdmin();
      } catch {
        return ctx.reply("I couldn't verify your group-admin rights. Try again when WhatsApp is connected, or ask the bot owner.");
      }
      if (!admin) return ctx.reply("Only the bot owner or a group admin can change pet settings.");
    }
    if (sub === "enable") {
      const options = parsePetEnable(rest);
      if (options.error) return ctx.reply(options.error);
    }
    if (sub === "rename" &&
      (!rest || rest.length > 40 ||
        [...rest].some((character) => character.charCodeAt(0) < 32))) {
      return ctx.reply("Choose a pet name of 1-40 characters on one line.");
    }
    if (sub === "hours") {
      const hours = rest.split(/\s+/);
      if (hours.length !== 2 || !hours.every((h) => /^\d{1,2}$/.test(h) && Number(h) < 24) ||
        Number(hours[0]) === Number(hours[1])) {
        return ctx.reply("Use bot.pet hours <start> <end>, distinct integer UTC hours from 0 to 23. Example: bot.pet hours 8 22.");
      }
    }
    if (sub === "answer" && !rest) return ctx.reply("Use bot.pet answer <answer>.");
    let notice: string | null = null;
    const now = Date.now();
    const response = pets.command(ctx.msg.chatId, sub, rest, now, () => {
      notice = achievements?.care(ctx.msg.chatId, messagePerson(ctx.msg), ctx.msg.senderName, now) ?? null;
    });
    const pet = pets.store.get(ctx.msg.chatId);
    if ((!sub || sub === "status") && pet) {
      return ctx.sendImage(await petPortrait(pet.stage, pet.hibernating || pet.request?.kind === "silence", pet.species), response);
    }
    return ctx.reply(notice ? `${response}\n\n${notice}` : response);
  };
}
