// Inline prompt flags for bot.paint, e.g. "g=4", "hard d=0.8", "pixelate p=24",
// "flux". Each parser returns the parsed value plus the prompt with its token(s)
// stripped so the remaining text is the clean image description.

const collapse = (s: string): string => s.replace(/\s{2,}/g, " ").trim();

// "g=4" / "guidance=4" — Flux edit strength; clamped 1-10.
export function parseGuidance(prompt: string, fallback: number): { guidance: number; text: string } {
  const m = prompt.match(/\b(?:g|guidance)\s*=\s*(\d+(?:\.\d+)?)\b/i);
  if (!m) return { guidance: fallback, text: prompt };
  const guidance = Math.min(10, Math.max(1, Number(m[1])));
  return { guidance, text: collapse(prompt.replace(m[0], "")) };
}

// "pixelate"/"8-bit" filter request + optional "p=24" block factor (clamped 6-64).
export function parsePixelate(prompt: string): { pixelate: boolean; factor: number } {
  const pixelate = /\bpixel(?:ate|ated|ize|ized|ised|s)?\b|\b8-?bit\b/i.test(prompt);
  const pm = prompt.match(/\bp\s*=\s*(\d{1,3})\b/i);
  const factor = pm ? Math.min(64, Math.max(6, Number(pm[1]))) : 24;
  return { pixelate, factor };
}

// "hard"/"strong" full-repaint flag + optional "d=0.7"/"denoise=0.7" (clamped 0.1-1).
export function parseRestyle(prompt: string): { hard: boolean; denoise: number | null; text: string } {
  let text = prompt;
  const hard = /\b(?:hard|strong)\b/i.test(text);
  if (hard) text = text.replace(/\b(?:hard|strong)\b/i, "");
  const dm = text.match(/\b(?:d|denoise)\s*=\s*(0?\.\d+|1(?:\.0+)?)\b/i);
  let denoise: number | null = null;
  if (dm) {
    denoise = Math.min(1, Math.max(0.1, Number(dm[1])));
    text = text.replace(dm[0], "");
  }
  return { hard, denoise, text: collapse(text) };
}

// Model selector: "flux"/"flux1" → Flux, else SDXL (the "sdxl" keyword is stripped).
export function parseModel(prompt: string): { model: "flux" | "sdxl"; text: string } {
  let text = prompt;
  let model: "flux" | "sdxl" = "sdxl";
  if (/\bflux1?\b/i.test(text)) {
    model = "flux";
    text = text.replace(/\bflux1?\b/i, "");
  } else if (/\bsdxl\b/i.test(text)) {
    text = text.replace(/\bsdxl\b/i, "");
  }
  return { model, text: collapse(text) };
}
