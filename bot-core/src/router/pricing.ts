export const DEFAULT_COST_CENTS = 10;
export const MUTE_COST_CENTS_PER_MINUTE = 20;
export const MUTE_DEBT_CENTS_PER_MINUTE = 100;
export const TRIVIA_SKIP_COST_CENTS = 20;
export const SIESTA_COST_CENTS_PER_MINUTE = 10;

export function euros(cents: number): string {
  return `EUR ${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, "0")}`;
}

export function isTriviaSkip(args: string): boolean {
  return /^(skip|next)$/i.test(args.trim());
}

// null means the handler charges only after accepting the action.
export function commandCost(id: string, args = ""): number | null {
  if (id === "billing" || id === "cost" || id === "achievements") return 0;
  if (id === "mute" || id === "siesta" || (id === "trivia" && isTriviaSkip(args))) return null;
  return id === "torture" ? 500 : DEFAULT_COST_CENTS;
}

export function costDescription(id: string): string {
  if (id === "siesta") return `${euros(SIESTA_COST_CENTS_PER_MINUTE)}/minute of accepted siesta (including forced sleep)`;
  if (id === "mute") return `${euros(MUTE_COST_CENTS_PER_MINUTE)}/minute; rejected mutes free`;
  if (id === "trivia") return `${euros(DEFAULT_COST_CENTS)}; skip/next ${euros(TRIVIA_SKIP_COST_CENTS)} on success`;
  const cents = commandCost(id);
  return cents === 0 ? "free" : euros(cents ?? DEFAULT_COST_CENTS);
}
