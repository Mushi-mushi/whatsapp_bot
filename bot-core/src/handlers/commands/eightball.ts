import type { Handler } from "../../router/router.js";

const ANSWERS = [
  "It is certain.",
  "Without a doubt.",
  "You may rely on it.",
  "Yes, definitely.",
  "As I see it, yes.",
  "Most likely.",
  "Outlook good.",
  "Signs point to yes.",
  "Reply hazy, try again.",
  "Ask again later.",
  "Better not tell you now.",
  "Cannot predict now.",
  "Don't count on it.",
  "My reply is no.",
  "My sources say no.",
  "Outlook not so good.",
  "Very doubtful.",
];

export const eightball: Handler = (ctx) => {
  const question = ctx.args.trim();
  const answer = ANSWERS[Math.floor(Math.random() * ANSWERS.length)];
  return ctx.reply(
    question ? `🎱 ${question}\n${answer}` : `🎱 ${answer}`,
  );
};
