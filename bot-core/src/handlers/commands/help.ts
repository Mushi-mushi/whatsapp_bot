import type { Handler } from "../../router/router.js";

export const help: Handler = (ctx) => {
  const triggers = Object.keys(ctx.config.commands).sort();
  const list = triggers.map((t) => `• ${t}`).join("\n");
  return ctx.reply(
    triggers.length
      ? `Here are the commands I know:\n${list}`
      : "No commands are configured yet.",
  );
};
