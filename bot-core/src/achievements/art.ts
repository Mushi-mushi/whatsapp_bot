import sharp from "sharp";
import { ACHIEVEMENTS, SECRET_ACHIEVEMENTS } from "../state/achievements.js";

type Motif = "chat" | "bolt" | "brain" | "trophy" | "ghost" | "microphone" |
  "mute" | "clock" | "coins" | "rocket" | "loop" | "receipt" | "calendar" |
  "owl" | "flag" | "comeback" | "medal" | "oracle" | "moon" | "paw" | "tools" | "crown";

const MOTIFS: Record<Motif, string> = {
  chat: '<path d="M92 117h200v119H179l-58 38v-38H92Z"/><path d="M126 154h132m-132 40h91" fill="none"/>',
  bolt: '<path d="M208 95l-88 117h64l-12 77 92-124h-66Z"/>',
  brain: '<path d="M189 125c-32-37-79-11-67 23-39 5-44 53-13 68-14 40 30 65 64 41l16 16Zm6 0c32-37 79-11 67 23 39 5 44 53 13 68 14 40-30 65-64 41l-16 16Z"/><path d="M143 159q34-4 30 28m-51 26q34-20 43 9m76-63q-34-4-30 28m51 26q-34-20-43 9" fill="none"/>',
  trophy: '<path d="M141 112h102v62q0 54-51 64-51-10-51-64Zm51 127v31m-40 9h80M141 133h-33v31q0 38 39 39m96-70h33v31q0 38-39 39"/><path d="m192 137 9 18 20 3-14 14 3 21-18-10-18 10 3-21-14-14 20-3Z" fill="#fff3ba" stroke-width="4"/>',
  ghost: '<path d="M121 271v-99a71 71 0 0 1 142 0v99l-24-19-24 19-23-19-24 19-23-19Z"/><ellipse cx="166" cy="176" rx="8" ry="13" fill="#16233b" stroke="none"/><ellipse cx="218" cy="176" rx="8" ry="13" fill="#16233b" stroke="none"/><path d="M176 215q16 17 32 0" fill="none"/>',
  microphone: '<rect x="163" y="106" width="58" height="118" rx="29"/><path d="M141 185v10a51 51 0 0 0 102 0v-10m-51 62v30m-32 0h64m-49-133h34m-34 25h34" fill="none"/>',
  mute: '<path d="M101 171h36l48-42v127l-48-42h-36Z"/><path d="m224 165 51 54m0-54-51 54" fill="none" stroke-width="15"/>',
  clock: '<circle cx="192" cy="194" r="77"/><path d="M192 139v59l36 20m-36-101v9m0 136v9m-77-77h9m136 0h9" fill="none"/><path d="m248 115 19 18m-150 0 19-18" fill="none"/>',
  coins: '<ellipse cx="165" cy="237" rx="57" ry="20"/><path d="M108 208v29m114-29v29"/><ellipse cx="165" cy="208" rx="57" ry="20"/><path d="M108 179v29m114-29v29"/><ellipse cx="165" cy="179" rx="57" ry="20"/><circle cx="239" cy="157" r="42"/><path d="M252 138h-14q-15 0-15 19t15 19h14m-39-26h31m-31 13h31" fill="none" stroke-width="5"/>',
  rocket: '<path d="M163 220q-5-81 85-112 13 94-57 128Zm-4-39-34 15-12 49 50-25m42 11-2 37-45 21 9-54"/><circle cx="211" cy="161" r="16" fill="#a5f3fc"/><path d="m144 242-19 20m27-10-10 21" fill="none" stroke="#ffb965"/>',
  loop: '<path d="M122 171a76 76 0 0 1 125-37l18 19m-3-43 3 43-43-3M262 216a76 76 0 0 1-125 37l-18-19m3 43-3-43 43 3" fill="none" stroke-width="16"/>',
  receipt: '<path d="M132 106l20 12 20-12 20 12 20-12 20 12 20-12v174l-20-12-20 12-20-12-20 12-20-12-20 12Z"/><path d="M158 151h68m-68 30h68m-68 30h32" fill="none"/><path d="m182 241 18 17 37-39" fill="none" stroke="#fff3ba"/>',
  calendar: '<rect x="112" y="125" width="160" height="145" rx="18"/><path d="M112 167h160m-121-58v32m82-32v32m-86 64h12m27 0h12m27 0h12m-90 32h12m27 0h12m27 0h12" fill="none"/>',
  owl: '<path d="m122 124 39 19q31-13 62 0l39-19-9 53q25 84-61 99-86-15-61-99Z"/><circle cx="163" cy="185" r="30" fill="#fff3ba"/><circle cx="221" cy="185" r="30" fill="#fff3ba"/><circle cx="163" cy="185" r="10" fill="#16233b" stroke="none"/><circle cx="221" cy="185" r="10" fill="#16233b" stroke="none"/><path d="m181 219 11 14 11-14Z" fill="#ffb965"/><path d="m174 260-8 17m44-17 8 17" fill="none"/>',
  flag: '<path d="M135 278V110m0 9q44-25 79 0t59 0v92q-30 25-59 0t-79 0" fill="none"/><path d="M142 130h30v30h-30m30 30h30v30h-30m30-87h30v30h-30m30 26h30v30h-30" stroke="none"/>',
  comeback: '<path d="M122 257q8-101 109-101h31m-39-39 39 39-39 39" fill="none" stroke-width="20"/><path d="m124 117 8 20 22 2-17 14 5 21-18-12-18 12 5-21-17-14 22-2Z" fill="#fff3ba" stroke-width="4"/>',
  medal: '<path d="m133 107 34 85h50l34-85h-42l-17 47-17-47Z"/><circle cx="192" cy="229" r="53"/><path d="M177 212q29-21 29 0 0 12-29 31h30" fill="none" stroke="#fff3ba" stroke-width="7"/>',
  oracle: '<circle cx="192" cy="181" r="68"/><path d="m164 148 18 28-17 18 40 23m18-61-13 19 15 13M149 243l-17 31h120l-17-31" fill="none"/><path d="m138 104 5 12m98-15-6 12m-119 29-11-5" fill="none" stroke="#fff3ba"/>',
  moon: '<path d="M232 111a83 83 0 1 0 37 135 72 72 0 0 1-37-135Z"/><path d="M229 143h33l-33 33h33m-8 24h24l-24 24h24" fill="none" stroke="#fff3ba" stroke-width="6"/>',
  paw: '<ellipse cx="140" cy="160" rx="20" ry="28" transform="rotate(-25 140 160)"/><ellipse cx="177" cy="137" rx="18" ry="27"/><ellipse cx="217" cy="140" rx="18" ry="27"/><ellipse cx="250" cy="170" rx="20" ry="28" transform="rotate(25 250 170)"/><path d="M150 209q40-48 79 0l21 32q2 34-32 23-26-12-51 0-35 11-32-23Z"/>',
  tools: '<path d="m135 118 26 26-18 18-26-26q-17 45 32 49l80 80 25-25-80-80q4-49-39-42Z"/><path d="m130 262 88-88m-9-24 37-37 27 27-37 37" fill="none" stroke-width="20"/>',
  crown: '<path d="m112 147 40 32 40-63 40 63 40-32-17 109H129Z"/><path d="M132 234h120" fill="none"/><circle cx="192" cy="204" r="12" fill="#fff3ba"/><circle cx="112" cy="139" r="9"/><circle cx="192" cy="107" r="9"/><circle cx="272" cy="139" r="9"/>',
};

const METRIC_MOTIFS: Record<typeof ACHIEVEMENTS[number]["metric"], Motif> = {
  messages: "chat", commands: "bolt", trivia: "brain", duels: "trophy", quietDays: "ghost",
  consecutive: "microphone", muteMinutes: "clock", muteCount: "mute", billCents: "coins",
};

const SECRET_MOTIFS: Record<typeof SECRET_ACHIEVEMENTS[number]["id"], Motif> = {
  "unmute-speedrun": "rocket", "regret-nothing": "loop", "still-worth-it": "receipt",
  "debt-free": "coins", "repeat-7": "calendar", "repeat-30": "calendar", "night-owl": "owl",
  "photo-finish": "flag", comeback: "comeback", "runner-up": "medal", "wrong-streak": "oracle",
  siestas: "moon", "pet-days": "paw", "command-variety": "tools", "return-king": "crown",
};

const PALETTES = [
  { metal: "#e5aa79", light: "#ffddba", dark: "#8a5033" },
  { metal: "#becfe2", light: "#f0f7ff", dark: "#657d9b" },
  { metal: "#f5c65c", light: "#fff1ad", dark: "#9b681d" },
] as const;
const cache = new Map<string, Promise<Buffer>>();

// Text lives in the WhatsApp caption so artwork also works in containers without system fonts.
export function achievementBadge(badgeId: string): Promise<Buffer> {
  const cached = cache.get(badgeId);
  if (cached) return cached;
  const regular = ACHIEVEMENTS.find((badge) => badge.id === badgeId);
  const secret = SECRET_ACHIEVEMENTS.find((badge) => badge.id === badgeId);
  const badge = regular ?? secret;
  if (!badge) throw new Error(`Unknown achievement badge: ${badgeId}`);
  const tier = regular ? ACHIEVEMENTS.filter((entry) => entry.metric === regular.metric)
    .findIndex((entry) => entry.id === badgeId) : badgeId === "repeat-30" ? 2 : 1;
  const palette = PALETTES[tier];
  const motif = regular ? METRIC_MOTIFS[regular.metric] : SECRET_MOTIFS[secret!.id];
  const accent = secret ? "#c4a0ff" : "#7adbd5";
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="384" height="384" viewBox="0 0 384 384">
    <defs>
      <linearGradient id="background" x2="1" y2="1"><stop stop-color="#1b2b48"/><stop offset="1" stop-color="#0b1222"/></linearGradient>
      <linearGradient id="metal" x2="1" y2="1"><stop stop-color="${palette.light}"/><stop offset=".5" stop-color="${palette.metal}"/><stop offset="1" stop-color="${palette.dark}"/></linearGradient>
      <radialGradient id="glow"><stop stop-color="${accent}" stop-opacity=".3"/><stop offset="1" stop-color="${accent}" stop-opacity="0"/></radialGradient>
    </defs>
    <rect width="384" height="384" rx="32" fill="url(#background)"/>
    <rect x="10" y="10" width="364" height="364" rx="25" fill="none" stroke="${palette.metal}" stroke-opacity=".4"/>
    <circle cx="192" cy="190" r="167" fill="url(#glow)"/>
    <path d="m120 265-15 80 46-22 33 33 8-77m72-14 15 80-46-22-33 33-8-77" fill="${secret ? "#6b46a4" : "#237d87"}" stroke="#0b1222" stroke-width="5"/>
    <path d="M192 51 313 98v96c0 78-66 121-121 144C137 315 71 272 71 194V98Z" fill="url(#metal)" stroke="${palette.light}" stroke-width="3"/>
    <path d="m192 67 106 41v86c0 65-57 105-106 127C143 299 86 259 86 194v-86Z" fill="#16233b" stroke="${palette.dark}" stroke-width="3"/>
    <path d="M105 118 192 84l87 34" fill="none" stroke="${accent}" stroke-width="3" opacity=".8"/>
    <g fill="${palette.metal}" stroke="${palette.light}" stroke-width="7" stroke-linecap="round" stroke-linejoin="round">${MOTIFS[motif]}</g>
    <g fill="${palette.light}">${Array.from({ length: tier + 1 }, (_, index) =>
      `<circle cx="${192 + (index - tier / 2) * 19}" cy="301" r="4"/>`).join("")}</g>
    <path d="m48 152 4 11 11 4-11 4-4 11-4-11-11-4 11-4Zm287 80 3 8 8 3-8 3-3 8-3-8-8-3 8-3Z" fill="${accent}"/>
    <path d="m192 23 5 7-5 7-5-7Z" fill="${accent}"/>
    <path d="M142 360h32m36 0h32" stroke="${palette.metal}" stroke-width="2" opacity=".6"/>
  </svg>`;
  const image = sharp(Buffer.from(svg)).png().toBuffer();
  cache.set(badgeId, image);
  void image.catch(() => cache.delete(badgeId));
  return image;
}
