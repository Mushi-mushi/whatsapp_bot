import type { Handler } from "../../router/router.js";
import { normalizeName } from "../../router/normalize.js";

const GENERIC = [
  "you bring everyone so much joy… when you leave the room.",
  "you're proof that even autocorrect gives up sometimes.",
  "you're not lazy, you're just on energy-saving mode 24/7.",
  "if brains were bandwidth, you'd still be on dial-up.",
  "you're the human version of a 'reply all' email.",
  "you're like a cloud — when you disappear, it's a beautiful day.",
  "you're not the sharpest tool, but you're definitely in the shed.",
  "you're like Monday — nobody's happy to see you, but here we are.",
  "you're the WiFi at a cheap hotel: weak, unreliable, and everywhere I don't want you.",
  "you're like a software update: whenever I see you, I think 'not now'.",
];

const SINGAPORE = [
  "you're kiasu about everything except being interesting, lah.",
  "you're like the durian of this chat: strong presence, and half of us want the window open.",
  "even the MRT breakdown apologises more sincerely than you do.",
  "you're proof Singapore is a fine city — every time you talk, I want to charge a fine.",
  "your chili crab energy is all shell, no meat.",
  "you can't even handle level-1 spicy at the hawker centre, let alone this roast.",
  "you're like the Merlion: mostly spitting, doing nothing useful.",
  "you complain about the humidity, but you're the one making everything sweat.",
];

const ARGENTINA = [
  "you're like Argentine inflation — always going up, delivering less every day, che.",
  "you take longer than an asado and still come out undercooked.",
  "you insist you invented everything, boludo, including this argument you're losing.",
  "your mate is bitter, but not as bitter as you after losing at truco.",
  "you've got the confidence of Maradona and the skill of a folding chair.",
  "you talk like you're from Buenos Aires and think like you're offside.",
  "even Messi couldn't assist you out of this personality.",
];

const FRANCE_ROAST = [
  "you're like a French strike: unannounced, inconvenient, and somehow proud of it.",
  "you have the aroma of a fine cheese and the charm of one too.",
  "you're all baguette — crusty outside, air inside.",
  "you say 'bof' to everything because effort scares you.",
  "you'd rather philosophise about the problem than ever fix it.",
  "you bring the energy of a Parisian waiter who's decided he hates you.",
];

const FRANCE_COMPLIMENT = [
  "you've got the effortless charm of a Parisian café on a sunny morning.",
  "you're as warm and comforting as a fresh croissant straight from the oven.",
  "you bring people together like a good bottle of Bordeaux over dinner.",
  "you have the timeless elegance of a stroll along the Seine.",
  "you make even ordinary moments feel like a scene from a French film.",
  "you light up the room like the Eiffel Tower at midnight.",
];

function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

function themeFor(target: string): string[] {
  const norm = normalizeName(target);
  const tokens = norm.split(" ");
  if (norm.includes("si ying") || norm.includes("siying") || tokens.includes("si")) return SINGAPORE;
  if (norm.includes("hernan")) return ARGENTINA;
  if (norm.includes("baptis")) return FRANCE_ROAST;
  return GENERIC;
}

export const roast: Handler = (ctx) => {
  const target = ctx.args.trim();
  const isNegative = (ctx.commandTrigger ?? "").endsWith(".neg");
  const isBaptiste = normalizeName(target).includes("baptis");

  if (isBaptiste && !isNegative) {
    return ctx.reply(`💙 ${target || "Baptiste"}, ${pick(FRANCE_COMPLIMENT)}`);
  }

  const line = pick(themeFor(target));
  return ctx.reply(target ? `🔥 ${target}, ${line}` : `🔥 ${line[0].toUpperCase()}${line.slice(1)}`);
};
