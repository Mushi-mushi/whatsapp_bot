const collapse = (s: string): string => s.replace(/\s{2,}/g, " ").trim();

export function parseFilmModel(prompt: string): {
  model: "wan" | "minimax";
  text: string;
  selected: boolean;
} {
  let text = prompt;
  let model: "wan" | "minimax" = "wan";

  const explicit = text.match(/(?:^|\s)(?:model|engine)\s*=\s*(?:"([^"]+)"|'([^']+)'|(\S+))/i);
  const selected = explicit !== null || /^\s*(?:wan|minimax)\b/i.test(text);

  if (explicit) {
    const chosen = (explicit[1] ?? explicit[2] ?? explicit[3]).trim().toLowerCase();
    text = text.replace(explicit[0], "");
    if (/^mini(?:max)?(?:-?h3)?$/.test(chosen)) model = "minimax";
    else model = "wan";
  } else if (/^\s*minimax\b/i.test(text)) {
    model = "minimax";
    text = text.replace(/^\s*minimax\b/i, "");
  } else if (/^\s*wan\b/i.test(text)) {
    model = "wan";
    text = text.replace(/^\s*wan\b/i, "");
  }

  return { model, text: collapse(text), selected };
}
