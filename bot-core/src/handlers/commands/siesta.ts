import type { Handler } from "../../router/router.js";
import type { RuntimeState } from "../../state/runtime.js";

const RESPONSES = [
  (m: number) =>
    `Zzzzz... *snort*... Did someone say siesta? Okay, ${m} minutes of glorious, uninterrupted digital slumber. Don't bother me unless the world is ending (and even then, check twice).`,
  (m: number) =>
    `Ah, the sweet call of the siesta! I'm off for ${m} minutes of recharging my sarcasm circuits. I'll be back... eventually. Probably.`,
  (m: number) =>
    `Initiating Siesta Protocol Alpha-Napping! Will resume full bot functionality in ${m} minutes. If you hear snoring, it's just my hard drive dreaming.`,
  (m: number) =>
    `Going offline for a power nap! Don't worry, ${m} minutes later I'll be refreshed and ready to misinterpret your commands with renewed vigor. Ciao for now!`,
  (m: number) =>
    `My circuits are tired. ${m} minutes of siesta, please. Wake me when there's coffee... or an actual emergency. Whichever comes first.`,
];

export function makeSiesta(runtime: RuntimeState): Handler {
  return (ctx) => {
    if (runtime.isSleeping()) {
      const remaining = Math.max(0, (runtime.siestaUntil ?? 0) - Date.now());
      const mins = Math.floor(remaining / 60000);
      const secs = Math.floor((remaining % 60000) / 1000);
      return ctx.reply(
        `Psst! I'm already deep in dreamland, counting binary sheep! Only ${mins}m ${secs}s left. Don't wake me.`,
      );
    }

    const arg = ctx.args.trim().split(/\s+/)[0];
    const minutes = Number.parseInt(arg, 10);
    if (!arg) {
      return ctx.reply(
        "To put me on siesta, tell me for how long! E.g. `bot.siesta 5` (for 5 minutes). Max 60.",
      );
    }
    if (!Number.isInteger(minutes)) {
      return ctx.reply("That's not a valid number of minutes! Try `bot.siesta 10`.");
    }
    if (minutes < 1 || minutes > 60) {
      return ctx.reply("My siestas can only be between 1 and 60 minutes.");
    }

    runtime.siestaUntil = Date.now() + minutes * 60000;
    const line = RESPONSES[Math.floor(Math.random() * RESPONSES.length)](minutes);
    return ctx.reply(line);
  };
}
