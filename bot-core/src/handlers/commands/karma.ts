import type { Handler } from "../../router/router.js";
import type { KarmaStore } from "../../state/repos.js";
import { normalizeName } from "../../router/normalize.js";

// Matches a name token immediately followed by ++ or -- (IRC-style karma).
const KARMA_GLOBAL = /([\p{L}\p{N}][\p{L}\p{N}_-]{1,30})(\+\+|--)/gu;
// Non-global copy for the router's hears() test (avoids lastIndex statefulness).
export const KARMA_PATTERN = /[\p{L}\p{N}][\p{L}\p{N}_-]{1,30}(\+\+|--)/u;

// Detects "name++" / "name--" in free text and updates the karma tally.
export function makeKarmaHears(karma: KarmaStore): Handler {
  return (ctx) => {
    const senderNorm = normalizeName(ctx.msg.senderName);
    const changes: string[] = [];
    const seen = new Set<string>();
    for (const m of ctx.text.matchAll(KARMA_GLOBAL)) {
      const name = m[1];
      const norm = normalizeName(name);
      if (!norm || seen.has(norm)) continue;
      seen.add(norm);
      if (norm === senderNorm) {
        changes.push(`Nice try — no self-karma, ${name}. 😏`);
        continue;
      }
      const points = karma.adjust(norm, name, m[2] === "++" ? 1 : -1);
      changes.push(`${name} now has ${points} karma.`);
    }
    if (changes.length) return ctx.reply(changes.join("\n"));
  };
}

// bot.karma [name] — query one person's karma or show the leaderboard.
export function makeKarma(karma: KarmaStore): Handler {
  return (ctx) => {
    const target = ctx.args.trim();
    if (!target) {
      const top = karma.top(5);
      if (!top.length) return ctx.reply("No karma yet. Give some with `name++`!");
      return ctx.reply(
        "🏆 Karma leaderboard:\n" + top.map((r, i) => `${i + 1}. ${r.name}: ${r.points}`).join("\n"),
      );
    }
    const rec = karma.get(normalizeName(target));
    return ctx.reply(rec ? `${rec.name} has ${rec.points} karma.` : `${target} has no karma yet.`);
  };
}
