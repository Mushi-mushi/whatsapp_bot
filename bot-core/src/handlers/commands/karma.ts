import type { Handler } from "../../router/router.js";
import type { KarmaStore, SeenActivityStore } from "../../state/repos.js";
import { normalizeName } from "../../router/normalize.js";
import { localTarget, messagePerson, playerLabel } from "./local-target.js";
import { chatKey } from "./user-context.js";

// Matches a name token immediately followed by ++ or -- (IRC-style karma).
const KARMA_GLOBAL = /([\p{L}\p{N}][\p{L}\p{N}_-]{1,30})(\+\+|--)/gu;
// Non-global copy for the router's hears() test (avoids lastIndex statefulness).
export const KARMA_PATTERN = /[\p{L}\p{N}][\p{L}\p{N}_-]{1,30}(\+\+|--)/u;

// Detects "name++" / "name--" in free text and updates the karma tally.
export function makeKarmaHears(karma: KarmaStore, people: SeenActivityStore): Handler {
  return (ctx) => {
    const changes: string[] = [];
    const seen = new Set<string>();
    for (const m of ctx.text.matchAll(KARMA_GLOBAL)) {
      const name = m[1];
      const norm = normalizeName(name);
      if (!norm || seen.has(norm)) continue;
      seen.add(norm);
      const target = localTarget(people, ctx.msg, name);
      if ("error" in target) {
        changes.push(target.error);
        continue;
      }
      if (target.person.sender_id === people.canonical(messagePerson(ctx.msg))) {
        changes.push(`Nice try — no self-karma, ${name}. 😏`);
        continue;
      }
      const points = karma.adjust(chatKey(ctx.msg), target.person.sender_id, target.person.name, m[2] === "++" ? 1 : -1);
      changes.push(`${target.person.name} now has ${points} karma.`);
    }
    if (changes.length) return ctx.reply(changes.join("\n"));
  };
}

// bot.karma [name] — query one person's karma or show the leaderboard.
export function makeKarma(karma: KarmaStore, people: SeenActivityStore): Handler {
  return (ctx) => {
    const target = ctx.args.trim();
    if (!target) {
      const top = karma.top(chatKey(ctx.msg), 5);
      if (!top.length) return ctx.reply("No karma yet. Give some with `name++`!");
      return ctx.reply(
        "🏆 Karma leaderboard:\n" + top.map((r, i) => `${i + 1}. ${playerLabel(r, top)}: ${r.points}`).join("\n"),
      );
    }
    const resolved = localTarget(people, ctx.msg, target);
    if ("error" in resolved) return ctx.reply(resolved.error);
    const rec = karma.get(chatKey(ctx.msg), resolved.person.sender_id);
    return ctx.reply(rec ? `${rec.name} has ${rec.points} karma.` : `${target} has no karma yet.`);
  };
}
