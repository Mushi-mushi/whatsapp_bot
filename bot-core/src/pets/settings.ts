import { z } from "zod";
import type { PetSettings } from "../../../shared/api.js";
export type { PetSettings } from "../../../shared/api.js";

export const PetSettingsSchema = z.object({
  wakeStart: z.number().int().min(0).max(23).default(8),
  wakeEnd: z.number().int().min(0).max(23).default(22),
  firstRequestMinutes: z.number().int().min(1).max(1440).default(15),
  requestMinHours: z.number().min(0.25).max(168).default(8),
  requestMaxHours: z.number().min(0.25).max(168).default(12),
  maxRequestsPerDay: z.number().int().min(0).max(24).default(3),
  activityWindowHours: z.number().min(0.25).max(168).default(6),
  responseMinutes: z.number().int().min(1).max(1440).default(30),
  silenceMinutes: z.number().int().min(1).max(30).default(2),
} satisfies Record<keyof PetSettings, z.ZodTypeAny>).strict().refine((s) => s.wakeStart !== s.wakeEnd, {
  message: "Waking start and end hours must differ.",
}).refine((s) => s.requestMinHours <= s.requestMaxHours, {
  message: "Minimum request interval cannot exceed the maximum.",
}) satisfies z.ZodType<PetSettings, z.ZodTypeDef, unknown>;
export const DEFAULT_PET_SETTINGS = PetSettingsSchema.parse({});
export function petSettings(pet: PetSettings): PetSettings {
  const result = { ...DEFAULT_PET_SETTINGS };
  for (const key of Object.keys(result) as (keyof PetSettings)[]) result[key] = pet[key];
  return result;
}
