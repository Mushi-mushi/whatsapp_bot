import type { Handler } from "../../router/router.js";

// Short descriptions for the known default triggers. Unlisted triggers still show
// (as a bare bullet) so custom commands aren't hidden.
const DESCRIPTIONS: Record<string, string> = {
  "bot.help": "show this list",
  "bot.status": "bot & services status",
  "bot.whoami": "how I identify you (name + owner)",
  "bot.ask": "ask the AI (personalised from what I know) — `bot.ask <question>` (pick a model with `model=<name>`)",
  "bot.ask.raw": "ask the AI without using learned profiles — `bot.ask.raw <question>`",
  "bot.models": "list the installed AI models — `bot.models`",
  "bot.as": "reply in the voice of a profiled person — `bot.as <name>: <question>`",
  "bot.profile": "what I've learned about someone here — `bot.profile [name]`",
  "bot.seen": "when someone was last active — `bot.seen <name>`",
  "bot.tell": "leave a message for someone — `bot.tell <name>: <message>`",
  "bot.remind": "set a reminder — `bot.remind 10m <text>` (s/m/h/d)",
  "bot.karma": "give or check karma — `bot.karma @name++`",
  "bot.translate": "translate text — `bot.translate <language> <text>`",
  "bot.tldr": "summarise a web page — `bot.tldr <url>`",
  "bot.weather": "weather — `bot.weather <place>`",
  "bot.meteo": "météo en français — `bot.meteo <lieu>`",
  "bot.roast": "playful roast — `bot.roast <name>`",
  "bot.roast.neg": "harsher roast — `bot.roast.neg <name>`",
  "bot.score": "sentiment score — `bot.score [name]`",
  "bot.top.positive": "most positive people here",
  "bot.top.negative": "most negative people here",
  "bot.jokes": "tell a joke",
  "bot.fact": "a random fact",
  "bot.8ball": "magic 8-ball — `bot.8ball <question>`",
  "bot.quote": "a random quote",
  "bot.roll": "roll dice — `bot.roll 2d6`",
  "bot.siesta": "put me on siesta — `bot.siesta <minutes>`",
  "bot.complain": "register a complaint — `bot.complain <text>`",
  "bot.torture": "spam the chat with silly one-liners",
  "bot.insults": "start an insult duel — `bot.insults start`",
  "bot.trivia": "start a trivia quiz — `bot.trivia` (`bot.trivia duel` to race)",
  "bot.paint": "generate an image — `bot.paint <prompt>`",
  "bot.film": "generate a short video — `bot.film <prompt>`",
  "bot.instadelete": "(owner) manage Instagram auto-delete",
  "bot.pet": "raise a shared group pet — `bot.pet help` (admins enable per group)",
};

export const help: Handler = (ctx) => {
  const triggers = Object.keys(ctx.config.commands).sort();
  if (triggers.length === 0) {
    return ctx.reply("No commands are configured yet.");
  }
  const list = triggers
    .map((t) => {
      const desc = DESCRIPTIONS[t];
      return desc ? `• \`${t}\` — ${desc}` : `• \`${t}\``;
    })
    .join("\n");
  return ctx.reply(`Here are the commands I know:\n${list}`);
};
