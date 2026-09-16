import type { Handler } from "../../router/router.js";
import type { SentimentStore } from "../../state/repos.js";

const LEVELS = [
  { name: "Le Tourist 🗼", threshold: 0 },
  { name: "Le Francophile 🧀", threshold: 10 },
  { name: 'Le "Débrouillard" 🍷', threshold: 20 },
  { name: 'Le "Râleur" 🥐', threshold: 30 },
  { name: 'Le "Bon Vivant" 🥖', threshold: 40 },
];

export function makeScore(sentiment: SentimentStore): Handler {
  return (ctx) => {
    const target = ctx.args.trim() || ctx.msg.senderName;
    if (!target) {
      return ctx.reply("Usage: `bot.score <Name>` (or just `bot.score` to check your own).");
    }

    const { total, count } = sentiment.scoreFor(target);
    if (count === 0) {
      return ctx.reply(`No logged messages found for sender: "${target}".`);
    }

    let levelIndex = 0;
    for (let i = LEVELS.length - 1; i >= 0; i--) {
      if (total >= LEVELS[i].threshold) {
        levelIndex = i;
        break;
      }
    }
    const current = LEVELS[levelIndex];
    const progress =
      levelIndex < LEVELS.length - 1
        ? `Next Level: ${(LEVELS[levelIndex + 1].threshold - total).toFixed(2)} points to reach ${LEVELS[levelIndex + 1].name}`
        : "You have reached the highest level!";

    return ctx.reply(
      [
        `- Current Level: ${current.name}`,
        `- Total Score: ${total.toFixed(2)}`,
        `- ${progress}`,
        `- Based on ${count} analyzed message(s).`,
      ].join("\n"),
    );
  };
}
