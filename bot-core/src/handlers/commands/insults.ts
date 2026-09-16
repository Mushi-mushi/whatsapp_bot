import type { Handler } from "../../router/router.js";
import type { RuntimeState } from "../../state/runtime.js";
import { createGame, nextBotInsult } from "../insults/game.js";

export function makeInsults(runtime: RuntimeState): Handler {
  return (ctx) => {
    const chat = ctx.msg.chatId;
    const sender = ctx.msg.senderName || "challenger";
    const sub = ctx.args.trim().toLowerCase();
    const existing = runtime.insultGames.get(chat);

    if (sub === "stop") {
      if (existing) {
        runtime.insultGames.delete(chat);
        return ctx.reply("The insult game has ended. You wisely retreated from my verbal onslaught.");
      }
      return ctx.reply("There's no insult game active here to stop, brave warrior.");
    }

    if (sub === "start" || sub === "") {
      if (existing) {
        return ctx.reply(
          `We are already in a heated verbal duel! Give me your comeback or type \`bot.insults stop\` to surrender. (Player ${existing.playerWins} - Bot ${existing.botWins})`,
        );
      }
      const game = createGame(sender);
      runtime.insultGames.set(chat, game);
      const first = nextBotInsult(game);
      return ctx.reply(
        [
          `A challenger approaches! Prepare yourself, ${sender}, for an Insult Duel!`,
          "Your goal: deliver the *correct* witty comeback to my insults.",
          "Type `bot.insults stop` to yield. Best of 5 rounds wins!",
          "",
          `I shall begin! '${first}'`,
        ].join("\n"),
      );
    }

    return ctx.reply("To play, type `bot.insults start`. To quit, type `bot.insults stop`.");
  };
}
