import sharp from "sharp";
import { STAGES, isSpecies, type Species } from "./model.js";

const cache = new Map<string, Promise<Buffer>>();

// Original vector portraits, rasterised locally for WhatsApp (which cannot send SVG).
export function petPortrait(stage: number, sleeping = false, species: Species = "bird"): Promise<Buffer> {
  if (!Number.isInteger(stage) || stage < 0 || stage >= STAGES.length) {
    throw new Error(`Invalid pet portrait stage: ${stage}`);
  }
  if (!isSpecies(species)) throw new Error(`Invalid pet portrait species: ${species}`);
  const key = `${species}:${stage}:${sleeping}`;
  const existing = cache.get(key);
  if (existing) return existing;
  const palettes = {
    bird: ["#fff1c2", "#ffe186", "#9ae6cf", "#89bfff", "#d8adff"],
    fox: ["#ffe1bf", "#ffc58a", "#f8a265", "#ec815b", "#ffbd5b"],
    cat: ["#e6dcff", "#c9b6ee", "#ad99db", "#9284cc", "#c5b8ff"],
    dragon: ["#daf2c3", "#b6df91", "#8fca82", "#6fba9b", "#69c9b9"],
  };
  const palette = palettes[species];
  const eyes = sleeping
    ? '<path d="M206 236q12 13 24 0m52 0q12 13 24 0" fill="none" stroke="#253552" stroke-width="7" stroke-linecap="round"/>'
    : '<ellipse cx="218" cy="234" rx="9" ry="14" fill="#253552"/><ellipse cx="294" cy="234" rx="9" ry="14" fill="#253552"/><circle cx="221" cy="230" r="3" fill="white"/><circle cx="297" cy="230" r="3" fill="white"/>';
  const wings = stage >= 2
    ? `<path d="M160 238Q${stage >= 3 ? 25 : 85} 150 105 295Q135 337 180 294M352 238Q${stage >= 3 ? 487 : 427} 150 407 295Q377 337 332 294" fill="${palette[stage]}" stroke="#435578" stroke-width="6"/>`
    : "";
  const crest = stage === 4
    ? '<path d="M203 165L193 81L239 124L256 52L278 124L324 81L309 170" fill="#ffc66b" stroke="#435578" stroke-width="6"/>'
    : stage > 0 ? '<path d="M232 169Q191 107 242 123Q255 77 277 119Q310 99 286 169" fill="#b3efd4" stroke="#435578" stroke-width="6"/>' : "";
  let body: string;
  if (stage === 0) {
    const marking = species === "fox" ? '<path d="M225 195l31-30 31 30-31 27Z" fill="#e88c53"/>'
      : species === "cat" ? '<path d="M270 162a29 29 0 1 0 0 57a22 22 0 0 1 0-57" fill="#9380c4"/>'
      : species === "dragon" ? '<path d="M256 158q-43 6-26 44q30 8 26-44m0 0q43 6 26 44q-30 8-26-44" fill="#77b475"/>'
      : "";
    body = `<path d="M256 131C202 131 157 226 157 292C157 396 355 396 355 292C355 226 310 131 256 131Z" fill="${palette[0]}" stroke="#435578" stroke-width="7"/><path d="M163 282l40-24 33 31 39-37 35 35 39-22" fill="none" stroke="${species === "bird" ? "#e5bf7c" : palette[3]}" stroke-width="9"/>${marking}`;
  } else if (species === "bird") {
    body = `${wings}${crest}<ellipse cx="256" cy="265" rx="${85 + stage * 5}" ry="112" fill="${palette[stage]}" stroke="#435578" stroke-width="7"/><ellipse cx="256" cy="302" rx="62" ry="63" fill="white" opacity=".55"/><path d="M236 259l20 17 20-17Z" fill="#eea154" stroke="#435578" stroke-width="4"/><path d="M215 372l-14 18m96-18 14 18" stroke="#eea154" stroke-width="12" stroke-linecap="round"/>`;
  } else {
    const color = palette[stage];
    const ears = species === "fox"
      ? `<path d="M169 211L154 ${125 - stage * 8}L228 173M284 173L358 ${125 - stage * 8}L343 211" fill="${color}" stroke="#435578" stroke-width="7"/><path d="M174 176l-5-34 32 31m110 0 32-31-5 34" fill="#ffe5cd"/>`
      : species === "cat"
      ? `<path d="M171 208L170 ${135 - stage * 5}L231 171M281 171L342 ${135 - stage * 5}L341 208" fill="${color}" stroke="#435578" stroke-width="7"/><path d="M187 170l-4-22 25 23m96 0 25-23-4 22" fill="#efbadb"/>`
      : `<path d="M190 185L178 119L220 159M292 159L334 119L322 185" fill="#f7dc9a" stroke="#435578" stroke-width="7"/><path d="M225 170l31-55 31 55" fill="${palette[4]}" stroke="#435578" stroke-width="6"/>`;
    const tail = species === "fox"
      ? `<path d="M316 351Q452 382 419 ${213 - stage * 10}Q365 221 352 319" fill="${color}" stroke="#435578" stroke-width="7"/><path d="M419 ${213 - stage * 10}Q426 267 417 290L391 268 373 282Q381 235 419 ${213 - stage * 10}" fill="#fff0d8"/>`
      : species === "cat"
      ? `<path d="M321 355Q424 378 401 286Q386 245 369 277" fill="none" stroke="#435578" stroke-width="30" stroke-linecap="round"/><path d="M321 355Q424 378 401 286Q386 245 369 277" fill="none" stroke="${color}" stroke-width="18" stroke-linecap="round"/>`
      : `<path d="M316 352Q426 397 438 298L403 319 418 271 381 296 387 251 351 290" fill="${color}" stroke="#435578" stroke-width="7"/>`;
    const dragonWings = species === "dragon" && stage >= 2
      ? `<path d="M181 280L${123 - stage * 10} 177L105 293 155 272 168 312M331 280L${389 + stage * 10} 177L407 293 357 272 344 312" fill="#a7d7ac" stroke="#435578" stroke-width="6"/>` : "";
    const face = species === "fox"
      ? '<path d="M169 241Q197 300 256 293Q315 300 343 241L293 257 256 280 219 257Z" fill="#fff0d8"/>'
      : species === "cat"
      ? '<path d="M191 263l-38-8m38 23-38 8m168-23 38-8m-38 23 38 8" stroke="#435578" stroke-width="4" stroke-linecap="round"/>'
      : '<ellipse cx="256" cy="274" rx="41" ry="23" fill="#d4edbb"/><circle cx="239" cy="271" r="4" fill="#435578"/><circle cx="273" cy="271" r="4" fill="#435578"/>';
    const accent = stage >= 3
      ? species === "cat"
        ? '<path d="M272 182a18 18 0 1 0 0 31a14 14 0 0 1 0-31" fill="#fff3ae"/>'
        : species === "fox"
        ? '<path d="M241 196l15-29 15 29-15 16Z" fill="#ffeab0"/>'
        : '<path d="M241 199l15-27 15 27-15 13Z" fill="#f8e3aa"/>' : "";
    const aura = stage === 4
      ? `<circle cx="256" cy="253" r="143" fill="none" stroke="${species === "fox" ? "#ffc66b" : species === "cat" ? "#c7b0ef" : "#9cd7ab"}" stroke-width="5" stroke-dasharray="10 16"/>` : "";
    body = `${aura}${tail}${dragonWings}${ears}<ellipse cx="256" cy="319" rx="${64 + stage * 4}" ry="69" fill="${color}" stroke="#435578" stroke-width="7"/><ellipse cx="256" cy="329" rx="43" ry="45" fill="white" opacity=".4"/><ellipse cx="256" cy="231" rx="${85 + stage * 3}" ry="76" fill="${color}" stroke="#435578" stroke-width="7"/>${face}${accent}
      ${species === "dragon" ? "" : '<path d="M245 260l11 9 11-9Z" fill="#435578"/><path d="M256 270v9m0-1q-10 10-17 0m17 0q10 10 17 0" fill="none" stroke="#435578" stroke-width="3"/>'}
      <ellipse cx="214" cy="376" rx="26" ry="12" fill="${color}" stroke="#435578" stroke-width="5"/><ellipse cx="298" cy="376" rx="26" ry="12" fill="${color}" stroke="#435578" stroke-width="5"/>`;
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">
    <rect width="512" height="512" rx="36" fill="${sleeping ? "#202d50" : "#eef7ff"}"/>
    <circle cx="412" cy="90" r="39" fill="${sleeping ? "#f5e6ac" : "#ffe8a3"}"/>
    <path d="M53 136h83m-42-41v82M383 179h38m-19-19v38" stroke="${sleeping ? "#8195bc" : "#bdd6ed"}" stroke-width="6" stroke-linecap="round"/>
    <ellipse cx="256" cy="395" rx="139" ry="24" fill="#96adc5" opacity=".25"/>
    ${body}${eyes}
    <ellipse cx="194" cy="259" rx="14" ry="8" fill="#f0a5a5" opacity=".65"/>
    <ellipse cx="318" cy="259" rx="14" ry="8" fill="#f0a5a5" opacity=".65"/>
    ${sleeping ? '<path d="M355 145h16l-16 18h16m13-62h26l-26 29h26" fill="none" stroke="#dbe6ff" stroke-width="4" stroke-linejoin="round"/>' : ""}
    ${Array.from({ length: stage + 1 }, (_, i) => `<circle cx="${256 + (i - stage / 2) * 25}" cy="451" r="7" fill="${sleeping ? "#e8efff" : "#435578"}"/>`).join("")}
  </svg>`;
  const image = sharp(Buffer.from(svg)).png().toBuffer();
  cache.set(key, image);
  void image.catch(() => cache.delete(key));
  return image;
}
