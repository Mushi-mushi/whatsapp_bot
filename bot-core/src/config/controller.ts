import type { BotConfig } from "./schema.js";

// Lets command handlers read and persist config changes (saves + applies live).
export interface ConfigController {
  get(): BotConfig;
  update(patch: Partial<BotConfig>): BotConfig;
}
