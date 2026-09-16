import type { InsultGame } from "../../state/runtime.js";

// Monkey Island-style insult / comeback pairs.
export const INSULTS_AND_COMEBACKS: Array<{ insult: string; comeback: string }> = [
  { insult: "You fight like a dairy farmer!", comeback: "How appropriate. You fight like a cow!" },
  { insult: "This is the END for you, you gutter-bred pig!", comeback: "I'm rubber, you're glue..." },
  { insult: "I will milk every drop of blood from your body!", comeback: "My tongue is quicker than yours has ever been!" },
  { insult: "Have you stopped wearing diapers yet?", comeback: "Why, did you want to borrow one?" },
  { insult: "I once owned a dog that was smarter than you.", comeback: "He must have taught you everything you know." },
  { insult: "No one will ever catch you in your lifetime!", comeback: "Yeah, and I'm a monkey's uncle." },
  { insult: "I've heard you were a contemptible sneak!", comeback: "And I've heard you're going to use that line on everyone!" },
  { insult: "You are a member of the most common species of rodent!", comeback: "Do I look like a rat to you?" },
  { insult: "You make me want to throw up!", comeback: "You make me want to get married!" },
  { insult: "I'm going to make you regret the day you were born!", comeback: "I'm going to make you wish you never met me!" },
  { insult: "Your mind is a barren wasteland!", comeback: "My wit is sharper than your dull blade!" },
  { insult: "My brain has too many convolutions to be impressed by you!", comeback: "And your face has too many convolutions to be seen in public!" },
  { insult: "You are a blot on the landscape!", comeback: "And you are a stain on my intelligence!" },
  { insult: "I have better things to do than listen to you!", comeback: "And I have better things to do than to insult your intellect!" },
  { insult: "You have the intelligence of a two-toed sloth!", comeback: "And you have the charm of a three-toed one!" },
  { insult: "Is that the best you can do?", comeback: "Is that the best you can ask?" },
];

export function createGame(targetSender: string, totalRounds = 5): InsultGame {
  return {
    targetSender,
    currentInsultIndex: null,
    playerWins: 0,
    botWins: 0,
    totalRounds,
    usedIndices: new Set(),
    lastInteraction: Date.now(),
  };
}

// Pick a fresh insult, record it as current, and return its text.
export function nextBotInsult(game: InsultGame): string {
  let available = [...INSULTS_AND_COMEBACKS.keys()].filter((i) => !game.usedIndices.has(i));
  if (available.length === 0) {
    game.usedIndices.clear();
    available = [...INSULTS_AND_COMEBACKS.keys()];
  }
  const chosen = available[Math.floor(Math.random() * available.length)];
  game.currentInsultIndex = chosen;
  game.usedIndices.add(chosen);
  game.lastInteraction = Date.now();
  return INSULTS_AND_COMEBACKS[chosen].insult;
}

export interface ComebackResult {
  text: string;
  finished: boolean;
}

// Judge the player's comeback, update the score, and advance the duel.
export function checkComeback(game: InsultGame, userText: string): ComebackResult {
  if (game.currentInsultIndex === null) {
    return { text: "I wasn't expecting a comeback! Type `bot.insults start` to duel.", finished: false };
  }

  const current = INSULTS_AND_COMEBACKS[game.currentInsultIndex];
  const expected = current.comeback.toLowerCase().trim();
  const got = userText.toLowerCase().trim();
  game.lastInteraction = Date.now();

  let response: string;
  if (got.includes(expected)) {
    game.playerWins += 1;
    response = `A brilliant retort! You parry my insult with wit! (Player ${game.playerWins} - Bot ${game.botWins})`;
  } else {
    game.botWins += 1;
    response = `Ha! A pathetic attempt! My verbal blade pierces your defenses! The correct comeback was: '${current.comeback}' (Player ${game.playerWins} - Bot ${game.botWins})`;
  }
  game.currentInsultIndex = null;

  if (game.playerWins + game.botWins >= game.totalRounds) {
    const final = `FINAL SCORE: Player ${game.playerWins} - Bot ${game.botWins}.`;
    if (game.playerWins > game.botWins) {
      response += `\n${final} Amazing! You have bested me in a duel of wits! I yield, for now... 😭`;
    } else if (game.playerWins < game.botWins) {
      response += `\n${final} Mwahaha! I am the undisputed master of insults! Better luck next time, human! 😎`;
    } else {
      response += `\n${final} A tie! How... anticlimactic. We shall meet again!`;
    }
    return { text: response, finished: true };
  }

  response += `\n\nPrepare yourself! Next insult: '${nextBotInsult(game)}'`;
  return { text: response, finished: false };
}
