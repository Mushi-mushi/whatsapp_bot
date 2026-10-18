import type { BackgroundJobs } from "./jobs.js";
import type { Bot, Handler } from "./router.js";

interface CommandAlias {
  trigger: string;
  description?: string;
  descriptionSuffix?: string;
}

interface CommandDefinition {
  description: string;
  usage: string;
  aliases: readonly CommandAlias[];
  execution: "inline" | "background";
}

export const COMMAND_CATALOGUE = {
  jokes: { description: "tell a joke", usage: "", aliases: [{ trigger: "bot.jokes" }], execution: "inline" },
  roast: {
    description: "playful roast", usage: "<name>",
    aliases: [{ trigger: "bot.roast.neg", description: "harsher roast", descriptionSuffix: ".neg" }, { trigger: "bot.roast" }],
    execution: "inline",
  },
  status: { description: "bot & services status", usage: "", aliases: [{ trigger: "bot.status" }], execution: "inline" },
  help: { description: "show this list", usage: "", aliases: [{ trigger: "bot.help" }], execution: "inline" },
  weather: { description: "weather", usage: "<place>", aliases: [{ trigger: "bot.weather" }], execution: "inline" },
  meteo: { description: "3-day weather forecast", usage: "[place]", aliases: [{ trigger: "bot.meteo" }], execution: "inline" },
  fact: { description: "a random fact", usage: "", aliases: [{ trigger: "bot.fact" }], execution: "inline" },
  eightball: { description: "magic 8-ball", usage: "<question>", aliases: [{ trigger: "bot.8ball" }], execution: "inline" },
  quote: { description: "a random quote", usage: "", aliases: [{ trigger: "bot.quote" }], execution: "inline" },
  siesta: { description: "put me on siesta", usage: "<minutes>", aliases: [{ trigger: "bot.siesta" }], execution: "inline" },
  complain: { description: "register a complaint", usage: "<text>", aliases: [{ trigger: "bot.complain" }], execution: "inline" },
  score: { description: "sentiment score", usage: "[name]", aliases: [{ trigger: "bot.score" }], execution: "inline" },
  top_positive: { description: "most positive people", usage: "", aliases: [{ trigger: "bot.top.positive" }], execution: "inline" },
  top_negative: { description: "most negative people", usage: "", aliases: [{ trigger: "bot.top.negative" }], execution: "inline" },
  torture: { description: "spam the chat with silly one-liners", usage: "", aliases: [{ trigger: "bot.torture" }], execution: "inline" },
  insults: { description: "start an insult duel", usage: "start", aliases: [{ trigger: "bot.insults" }], execution: "inline" },
  ask: {
    description: "ask the AI (personalised from what I know); pick a model with model=<name>",
    usage: "<question>",
    aliases: [{ trigger: "bot.ask" }, { trigger: "bot.ask.raw", description: "ask the AI without using learned profiles", descriptionSuffix: ".raw" }],
    execution: "background",
  },
  models: { description: "list the installed AI models", usage: "", aliases: [{ trigger: "bot.models" }], execution: "inline" },
  as_user: { description: "reply in the voice of a profiled person", usage: "<name>: <question>", aliases: [{ trigger: "bot.as" }], execution: "background" },
  profile: { description: "what I've learned about someone here", usage: "[name]", aliases: [{ trigger: "bot.profile" }], execution: "background" },
  seen: { description: "when someone was last active", usage: "<name>", aliases: [{ trigger: "bot.seen" }], execution: "inline" },
  whoami: { description: "how I identify you (name + owner)", usage: "", aliases: [{ trigger: "bot.whoami" }], execution: "inline" },
  tell: { description: "leave a message for someone", usage: "<name>: <message>", aliases: [{ trigger: "bot.tell" }], execution: "inline" },
  remind: { description: "set a reminder (s/m/h/d)", usage: "10m <text>", aliases: [{ trigger: "bot.remind" }], execution: "inline" },
  karma: { description: "check karma; give karma with name++ in chat", usage: "[name]", aliases: [{ trigger: "bot.karma" }], execution: "inline" },
  translate: { description: "translate text", usage: "<language> <text>", aliases: [{ trigger: "bot.translate" }], execution: "background" },
  tldr: { description: "summarise a web page", usage: "<url>", aliases: [{ trigger: "bot.tldr" }], execution: "background" },
  roll: { description: "roll dice", usage: "2d6", aliases: [{ trigger: "bot.roll" }], execution: "inline" },
  trivia: { description: "start a trivia quiz; use duel for a race", usage: "[help|duel]", aliases: [{ trigger: "bot.trivia" }], execution: "inline" },
  paint: { description: "generate an image", usage: "<prompt>", aliases: [{ trigger: "bot.paint" }], execution: "background" },
  film: { description: "generate a short video", usage: "<prompt>", aliases: [{ trigger: "bot.film" }], execution: "background" },
  instadelete: { description: "(owner) manage Instagram auto-delete", usage: "[on|off|status|list|add <who>|remove <who>|clear]", aliases: [{ trigger: "bot.instadelete" }], execution: "inline" },
  pet: { description: "raise a shared group pet (admins enable per group)", usage: "help", aliases: [{ trigger: "bot.pet" }], execution: "inline" },
  services: { description: "(owner) enable, disable, or check Ollama and ComfyUI", usage: "[status|on|off] [ollama|comfyui|all]", aliases: [{ trigger: "bot.services" }], execution: "inline" },
} as const satisfies Record<string, CommandDefinition>;

export type CommandId = keyof typeof COMMAND_CATALOGUE;
export type CommandRegistry = Record<CommandId, Handler>;

export function getCommandDefinition(id: string): CommandDefinition | undefined {
  return Object.hasOwn(COMMAND_CATALOGUE, id) ? COMMAND_CATALOGUE[id as CommandId] : undefined;
}

export function defaultCommands(): Record<string, string> {
  return Object.fromEntries(Object.entries(COMMAND_CATALOGUE).flatMap(([id, definition]) =>
    definition.aliases.map(({ trigger }) => [trigger, id])));
}

export function commandHelp(trigger: string, id: string): string | undefined {
  const definition = getCommandDefinition(id);
  if (!definition) return undefined;
  const lower = trigger.toLowerCase();
  const alias = definition.aliases.find((entry) => entry.trigger.toLowerCase() === lower)
    ?? definition.aliases.find((entry) => entry.descriptionSuffix && lower.endsWith(entry.descriptionSuffix));
  const description = alias?.description ?? definition.description;
  return `${description}${definition.usage ? ` — \`${trigger} ${definition.usage}\`` : ""}`;
}

export function registerConfiguredCommands(
  bot: Bot,
  commands: Readonly<Record<string, string>>,
  registry: CommandRegistry,
  jobs: BackgroundJobs,
  warn: (trigger: string, name: string) => void,
): void {
  bot.clearCommands();
  for (const [trigger, name] of Object.entries(commands)) {
    const definition = getCommandDefinition(name);
    if (!definition) {
      warn(trigger, name);
      continue;
    }
    const handler = registry[name as CommandId];
    bot.command(trigger, definition.execution === "background" ? jobs.wrap(handler) : handler);
  }
}
