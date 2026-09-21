// Name normalization: accent/emoji/case-insensitive, matching the Python bot's behavior.
export function normalizeName(name: string | null | undefined): string {
  return String(name ?? "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "") // strip combining marks (accents)
    .replace(/[\u200d\uFE0F]/g, "") // ZWJ + variation selector
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

// Looser person-name key used by tell/seen-like features: keeps letters/numbers,
// drops punctuation and emoji so "Alice 🌟" and "Alice" map together.
export function normalizeLooseName(name: string | null | undefined): string {
  return normalizeName(name)
    .replace(/[^\p{L}\p{N}\s]/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}

// Extract a bot command token (supports dotted subcommands like "bot.roast.neg")
// from mixed text, ignoring a trailing "HH:MM" timestamp.
export function extractCommandToken(text: string | null | undefined): string | null {
  const cleaned = String(text ?? "")
    .replace(/\s+/g, " ")
    .replace(/\s+\d{1,2}:\d{2}\s*$/, "")
    .trim();
  if (!cleaned) return null;
  const match = cleaned.match(/\bbot\.[a-z0-9_-]+(?:\.[a-z0-9_-]+)*(?:\s+.*)?$/i);
  return match ? match[0].trim() : null;
}
