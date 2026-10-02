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
  "you're like a screenshot of a screenshot — technically here, but nobody can make you out.",
  "you've got the depth of a puddle and the loading speed of dial-up.",
  "you're the 'terms and conditions' nobody reads and everyone agrees to ignore.",
  "you're living proof that talking and saying something are two very different skills.",
  "you're like a group project — somehow everyone else did more than you.",
  "you're the participation trophy of this conversation.",
  "you have the energy of a phone at 1% that refuses to just switch off.",
  "you're like a pop-up ad: unwanted, poorly timed, and weirdly persistent.",
  "you're the loading spinner of people: always there, never useful.",
  "you have two brain cells, and both are buffering.",
  "you're the typo in an important email everyone pretends not to see.",
  "you're like decaf drama: still annoying, just less effective.",
  "you're the reason mute buttons were invented.",
  "you make small talk feel like a long-haul flight delay.",
  "you're like expired coupons: loud confidence, zero value.",
  "you bring chaos with the precision of a broken alarm clock.",
  "you're the human equivalent of low-battery anxiety.",
  "you argue like a terms-of-service popup: impossible to close and never helpful.",
  "you're like rain on laundry day: badly timed and universally disliked.",
  "you're the side quest nobody accepted.",
  "you've mastered the art of being wrong with conviction.",
  "you're like auto-play videos: nobody asked, yet here you are.",
  "you're proof that volume and intelligence are unrelated metrics.",
  "you're the debug log of social interactions: too much noise, no signal.",
  "you treat every opinion like a hostage situation.",
  "you're like an alarm set for 3 a.m.: technically functional, morally questionable.",
  "you have the consistency of hotel WiFi during a storm.",
  "you're the plot twist nobody enjoyed.",
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
  "you're queueing for attention like it's bubble tea launch day, and still nobody buying.",
  "your confidence is ERP gantry rates: high for no good reason.",
  "you move slower than peak-hour traffic on the PIE after one tiny drizzle.",
  "you're as reliable as the weather forecast during monsoon season.",
  "you talk big, but your follow-through is last-train timing on New Year's Eve.",
  "you're like kopi-o kosong with no kopi: all talk, no substance.",
  "even a chope packet has stronger claim to this table than your opinion.",
  "you bring the energy of a 6 p.m. CBD lift queue: long, painful, and avoidable.",
  "you're more confusing than Sim Lim warranty terms.",
  "you flex like Orchard Road prices and deliver like pasar malam quality.",
  "your logic has more detours than roadworks near Thomson line, lah.",
  "you're the only person who can make air-con feel stressful.",
  "you've got the urgency of someone tapping in with 3 cents left on EZ-Link.",
  "your stories are longer than the queue at Ya Kun on Monday morning.",
  "you act atas, but your arguments are hawker tray return level basic.",
  "you're like SG heat: intense, inescapable, and bad for everyone's mood.",
  "your banter is as dry as a chicken rice stall that ran out of sauce.",
  "even COE prices make more sense than your decisions.",
  "you sound like a condo brochure: premium words, tiny actual value.",
  "you're the extra charge on Grab that nobody can explain.",
];

const ARGENTINA = [
  "you're like Argentine inflation — always going up, delivering less every day, che.",
  "you take longer than an asado and still come out undercooked.",
  "you insist you invented everything, boludo, including this argument you're losing.",
  "your mate is bitter, but not as bitter as you after losing at truco.",
  "you've got the confidence of Maradona and the skill of a folding chair.",
  "you talk like you're from Buenos Aires and think like you're offside.",
  "even Messi couldn't assist you out of this personality.",
  "you dribble conversations straight out of bounds and call it strategy, che.",
  "your excuses age worse than fernet left in the sun.",
  "you bring tango passion with parking-lot coordination.",
  "you're all Boca noise and zero finishing.",
  "you argue like VAR: slow, dramatic, and still wrong.",
  "your plans collapse faster than a beach umbrella in Patagonian wind.",
  "you've got more smoke than a Sunday asado and less flavour.",
  "you celebrate tiny wins like you lifted the World Cup alone, boludo.",
  "you've got Palermo prices and barrio-level quality.",
  "your timing is so bad even a bandoneon sounds rushed next to you.",
  "you bring the consistency of bus schedules during a city protest.",
  "you talk economics like inflation is a personality trait.",
  "you've got the touch of a striker wearing ski boots.",
  "you're as subtle as a bombito at 2 a.m. on a weekday.",
  "you could miss an open goal in an empty stadium.",
  "your confidence is Recoleta, your results are once station.",
  "you turn every mate round into a TED Talk nobody asked for.",
  "you're the choripan of opinions: fast, messy, and gone in two bites.",
  "you've got all the attitude of a derby and none of the talent.",
  "if denial were football, you'd be top scorer every season.",
];

const FRANCE_ROAST = [
  "you're like a French strike: unannounced, inconvenient, and somehow proud of it.",
  "you have the aroma of a fine cheese and the charm of one too.",
  "you're all baguette — crusty outside, air inside.",
  "you say 'bof' to everything because effort scares you.",
  "you'd rather philosophise about the problem than ever fix it.",
  "you bring the energy of a Parisian waiter who's decided he hates you.",
  "you're like lukewarm espresso: bitter, tiny, and disappointing.",
  "you ghost responsibility faster than a scooter on rue de Rivoli.",
  "your confidence is haute couture, your execution is discount bin.",
  "you critique everyone like Michelin, then cook like a microwave.",
  "you're more dramatic than rain in Paris and twice as predictable.",
  "you bring revolutionary energy to tasks no one assigned.",
  "your logic folds faster than a crepe at brunch.",
  "you sigh in French and still make no point.",
  "you wear sarcasm like cologne: too much and everyone notices.",
  "you treat deadlines like museum pieces: to be admired from afar.",
  "you're an art-house film of a person: long, confusing, and no payoff.",
  "even your compliments sound like customer complaints.",
  "you take forever to arrive and still show up underdressed for the task.",
  "your productivity is closed for august.",
  "you debate like a philosopher and decide like a coin flip.",
  "you're all terrace aesthetics and basement-level substance.",
  "you manage to be condescending and incorrect in one sentence.",
  "your follow-up game is as rare as free water at a fancy bistro.",
  "you could make a standing ovation feel passive-aggressive.",
  "you have the urgency of a three-hour lunch and the output of a nap.",
];

const FRANCE_COMPLIMENT = [
  "you've got the effortless charm of a Parisian café on a sunny morning.",
  "you're as warm and comforting as a fresh croissant straight from the oven.",
  "you bring people together like a good bottle of Bordeaux over dinner.",
  "you have the timeless elegance of a stroll along the Seine.",
  "you make even ordinary moments feel like a scene from a French film.",
  "you light up the room like the Eiffel Tower at midnight.",
];

const AMERICA = [
  "you're like a bottomless soda refill: endless, watered down, and nobody asked.",
  "you've got the confidence of a monster truck and the fuel economy to match.",
  "you're the human equivalent of a '2-day shipping' estimate that takes two weeks.",
  "you deep-fry every conversation and still somehow serve it bland.",
  "you talk like the movie trailer and deliver like the straight-to-DVD sequel.",
  "you're all star-spangled hype and zero follow-through.",
  "you've got more warning labels than a bottle of hot sauce and half the kick.",
  "you're like a gas-station hot dog: technically an option, immediately regretted.",
  "you insist you're number one, but even the participation trophy looks embarrassed.",
  "you supersize everything except the actual point you're trying to make.",
  "you're the pumpkin-spice of people: everywhere for a month, tolerated at best.",
  "you've got drive-thru wisdom — fast, cheap, and bad for everyone involved.",
  "you're like a campaign ad: loud, expensive, and light on facts.",
  "you bring main-character energy with background-actor results.",
  "you're all fireworks and no infrastructure.",
  "you talk freedom, then trap everyone in a 45-minute story.",
  "you're the extended warranty call of human interactions.",
  "your attention span is one halftime show and a commercial break.",
  "you've got the subtlety of a pickup truck horn at 6 a.m.",
  "you're like diner coffee: hot, dark, and mostly regret.",
  "you debate like cable news: zero listening, max volume.",
  "your confidence has national debt energy.",
  "you're the convenience fee nobody agreed to.",
  "you've got startup pitch confidence and empty-slide content.",
  "you overpromise like a blockbuster trailer and deliver like season 9.",
  "you're all tailgate hype and no actual game plan.",
  "you treat facts like optional toppings.",
  "you're the online recipe with a life story before the ingredients.",
  "you've got 4K attitude and 144p execution.",
  "you're like airport food: overpriced, underwhelming, and somehow unavoidable.",
  "you bring the certainty of GPS in a dead zone.",
  "you're the software terms checkbox of people: clicked through, never respected.",
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
  if (norm.includes("tristan") || norm.includes("rhea")) return AMERICA;
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
