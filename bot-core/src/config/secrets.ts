import type { BotConfig } from "./schema.js";

// Config fields that must never leave the server in plaintext.
export const SECRET_FIELDS = ["redditClientSecret", "redditRefreshToken"] as const;

// Placeholder returned to clients in place of a real secret. When a client saves
// the config back unchanged, this sentinel is swapped for the stored value.
export const REDACTED = "__redacted__";

// Mask secret fields for outbound responses (only when a value is actually set).
export function redactSecrets(config: BotConfig): BotConfig {
  const out = { ...config };
  for (const field of SECRET_FIELDS) {
    if (out[field]) out[field] = REDACTED;
  }
  return out;
}

// Restore any redacted secret to its stored value so a round-tripped save from a
// client (which only ever saw the sentinel) does not wipe the real secret.
export function restoreSecrets(incoming: BotConfig, stored: BotConfig): BotConfig {
  const out = { ...incoming };
  for (const field of SECRET_FIELDS) {
    if (out[field] === REDACTED) out[field] = stored[field];
  }
  return out;
}
