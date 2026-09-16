// Small time helpers for the seen / remind commands.

const UNIT_MS: Record<string, number> = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };

// Parse a leading duration like "10m", "2 h", "30s", "1d" -> milliseconds (or null).
export function parseDuration(input: string): { ms: number; rest: string } | null {
  const m = input
    .trim()
    .match(/^(\d+)\s*(s|sec|secs|second|seconds|m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days)\b\s*(.*)$/is);
  if (!m) return null;
  const n = Number.parseInt(m[1], 10);
  const ms = n * (UNIT_MS[m[2][0].toLowerCase()] ?? 60_000);
  return { ms, rest: m[3].trim() };
}

export function formatDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

export function timeAgo(ts: number): string {
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}
