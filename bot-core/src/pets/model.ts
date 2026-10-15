import { DEFAULT_PET_SETTINGS, type PetSettings } from "./settings.js";

export const HOUR = 3_600_000;
export const DAY = 24 * HOUR;
export const STAGES = [
  { name: "Cloud Egg", emoji: "\u{1f95a}", days: 0 },
  { name: "Cloud Chick", emoji: "\u{1f423}", days: 1 },
  { name: "Breeze Bird", emoji: "\u{1f425}", days: 7 },
  { name: "Sky Guardian", emoji: "\u{1f426}", days: 21 },
  { name: "Aurora Phoenix", emoji: "\u{1f525}", days: 60 },
] as const;

export const SPECIES = {
  bird: { name: "Cloud Bird", forms: ["Cloud Egg", "Cloud Chick", "Breeze Bird", "Sky Guardian", "Aurora Phoenix"], emoji: ["\u{1f95a}", "\u{1f423}", "\u{1f425}", "\u{1f426}", "\u{1f525}"] },
  fox: { name: "Ember Fox", forms: ["Ember Egg", "Ember Kit", "Spark Fox", "Flame Guardian", "Solar Fox"], emoji: ["\u{1f95a}", "\u{1f98a}", "\u{1f98a}", "\u{1f525}", "\u{2600}"] },
  cat: { name: "Moon Cat", forms: ["Moon Egg", "Moon Kitten", "Dusk Cat", "Lunar Guardian", "Celestial Cat"], emoji: ["\u{1f95a}", "\u{1f431}", "\u{1f408}", "\u{1f319}", "\u{2728}"] },
  dragon: { name: "Moss Dragon", forms: ["Moss Egg", "Moss Hatchling", "Fern Drake", "Forest Guardian", "Ancient Dragon"], emoji: ["\u{1f95a}", "\u{1f409}", "\u{1f409}", "\u{1f332}", "\u{1f432}"] },
} as const;
export type Species = keyof typeof SPECIES;
export const SPECIES_IDS = Object.keys(SPECIES) as Species[];

export function isSpecies(value: string): value is Species {
  return Object.hasOwn(SPECIES, value);
}

export function parsePetEnable(input: string): { name: string; species?: Species; error?: string } {
  let species: Species | undefined;
  const name: string[] = [];
  for (const token of input.trim().split(/\s+/)) {
    if (/^species=/i.test(token)) {
      const value = token.slice(8).toLowerCase();
      if (species || !isSpecies(value)) {
        return { name: "", error: `Choose one species: ${SPECIES_IDS.join(", ")}. Example: bot.pet enable Mochi species=fox` };
      }
      species = value;
    } else if (token) name.push(token);
  }
  const result = name.join(" ");
  if (result.length > 40 || [...input].some((character) => character.charCodeAt(0) < 32)) {
    return { name: "", error: "Choose a pet name of 1-40 characters on one line." };
  }
  return { name: result || "Mochi", species };
}

export type RequestKind = "feed" | "water" | "clean" | "play" | "silence";
export interface PetRequest {
  eventId: string;
  kind: RequestKind;
  answer: string;
  startedAt: number | null;
  deadline: number | null;
  manual?: boolean;
}

export interface Pet extends PetSettings {
  chatId: string;
  species: Species;
  name: string;
  enabled: boolean;
  paused: boolean;
  stage: number;
  hunger: number;
  hydration: number;
  cleanliness: number;
  happiness: number;
  energy: number;
  healthyMs: number;
  clock: number;
  lastTick: number;
  lastActivity: number;
  criticalMs: number;
  warned: boolean;
  hibernating: boolean;
  hibernationMs: number;
  devolved: boolean;
  rescueFed: boolean;
  rescueAnswered: boolean;
  rescueRiddle: number;
  graceUntil: number;
  nextRequest: number;
  requestDay: string;
  requestsToday: number;
  request: PetRequest | null;
  lastFeed: number;
  lastWater: number;
  lastClean: number;
  lastPlay: number;
  wakeStart: number;
  wakeEnd: number;
}

export const RIDDLES = [
  { question: "What has hands but cannot clap?", answers: ["clock", "a clock"] },
  { question: "What gets wetter as it dries?", answers: ["towel", "a towel"] },
  { question: "What has keys but cannot open a door?", answers: ["piano", "a piano", "keyboard", "a keyboard"] },
];

export function createPet(chatId: string, name: string, now: number, species: Species = "bird"): Pet {
  return {
    ...DEFAULT_PET_SETTINGS,
    chatId, species, name, enabled: true, paused: false, stage: 0,
    hunger: 100, hydration: 100, cleanliness: 100, happiness: 100, energy: 100, healthyMs: 0,
    clock: 0, lastTick: now, lastActivity: now,
    criticalMs: 0, warned: false, hibernating: false, hibernationMs: 0,
    devolved: false, rescueFed: false, rescueAnswered: false, rescueRiddle: 0,
    graceUntil: 0, nextRequest: 15 * 60_000, requestDay: "", requestsToday: 0,
    request: null, lastFeed: -HOUR, lastWater: -HOUR, lastClean: -HOUR, lastPlay: -HOUR, wakeStart: 8, wakeEnd: 22,
  };
}

export function awake(pet: Pet, now: number): boolean {
  const hour = new Date(now).getUTCHours();
  return pet.wakeStart < pet.wakeEnd
    ? hour >= pet.wakeStart && hour < pet.wakeEnd
    : hour >= pet.wakeStart || hour < pet.wakeEnd;
}

export function title(pet: Pet): string {
  const species = SPECIES[pet.species];
  return `${species.emoji[pet.stage]} *${pet.name}* - ${species.forms[pet.stage]}`;
}

export function needsCare(pet: Pet): boolean {
  return [pet.hunger, pet.hydration, pet.cleanliness, pet.happiness, pet.energy].some((value) => value <= 20);
}

export function rescueText(pet: Pet): string {
  return `${pet.rescueFed ? "[done]" : "[needed]"} Leave a snack: bot.pet feed\n` +
    `${pet.rescueAnswered ? "[done]" : "[needed]"} Dream-riddle: ${RIDDLES[pet.rescueRiddle].question}\n` +
    "Use bot.pet answer <answer>. One person can do both steps; there is no rescue deadline.";
}

export function statusText(pet: Pet): string {
  const next = STAGES[pet.stage + 1];
  const progress = next
    ? `Next evolution: ${(pet.healthyMs / DAY).toFixed(1)}/${next.days} healthy days.`
    : "Final form unlocked!";
  const request = pet.request && pet.request.startedAt !== null
    ? `\nActive request: ${pet.request.kind}. ` +
      (pet.request.kind === "silence" ? "Please stay silent!"
        : `Use bot.pet ${pet.request.kind === "play" ? "answer <number from 1 to 5>" : pet.request.kind}.`)
    : pet.request ? "\nA request is waiting for delivery." : "";
  return `${title(pet)}${!pet.enabled ? " [disabled]" : pet.paused ? " [paused]" : ""}\nSpecies: ${SPECIES[pet.species].name}\n` +
    (pet.hibernating ? `Hibernating${pet.devolved ? " (devolved)" : ""}.\n${rescueText(pet)}`
      : `Food ${Math.round(pet.hunger)}/100 | Water ${Math.round(pet.hydration)}/100 | Cleanliness ${Math.round(pet.cleanliness)}/100\nHappiness ${Math.round(pet.happiness)}/100 | Energy ${Math.round(pet.energy)}/100\n${progress}${request}`) +
    `\nWaking hours: ${pet.wakeStart}:00-${pet.wakeEnd}:00 UTC.`;
}
