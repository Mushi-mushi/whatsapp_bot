import type { Handler } from "../../router/router.js";
import { commandHelp } from "../../router/commands.js";

export const help: Handler = (ctx) => {
  const triggers = Object.keys(ctx.config.commands).sort();
  if (triggers.length === 0) {
    return ctx.reply("No commands are configured yet.");
  }
  const list = triggers
    .map((trigger) => {
      const description = commandHelp(trigger, ctx.config.commands[trigger]);
      return description ? `• \`${trigger}\` — ${description}` : `• \`${trigger}\``;
    })
    .join("\n");
  return ctx.reply(`Here are the commands I know:\n${list}`);
};
