import type { Handler } from "../../router/router.js";

// bot.roll [NdM(+/-K)] — dice roller. Defaults to 1d6.
export const roll: Handler = (ctx) => {
  const spec = (ctx.args.trim() || "1d6").toLowerCase().replace(/\s+/g, "");
  const m = spec.match(/^(\d*)d(\d+)([+-]\d+)?$/);
  if (!m) {
    return ctx.reply("Usage: `bot.roll 2d6`, `bot.roll d20`, `bot.roll 3d8+2`.");
  }
  const count = m[1] ? Number.parseInt(m[1], 10) : 1;
  const sides = Number.parseInt(m[2], 10);
  const mod = m[3] ? Number.parseInt(m[3], 10) : 0;
  if (count < 1 || count > 100 || sides < 2 || sides > 1000) {
    return ctx.reply("Keep it sane: 1–100 dice, 2–1000 sides.");
  }

  const rolls = Array.from({ length: count }, () => 1 + Math.floor(Math.random() * sides));
  const total = rolls.reduce((a, b) => a + b, 0) + mod;
  const detail = count > 1 || mod ? ` (${rolls.join(", ")}${mod ? m[3] : ""})` : "";
  return ctx.reply(`🎲 ${spec} → *${total}*${detail}`);
};
