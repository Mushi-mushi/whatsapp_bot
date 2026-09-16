import type { Handler } from "../../router/router.js";
import type { RuntimeState } from "../../state/runtime.js";

const TORTURE_MESSAGES = [
  "Knock, knock. Who's there? Bot. Bot who? Bot-ter get ready for some fun!",
  "Did you know a group of pugs is called a 'grumble'? Just thought you should know.",
  "Why don't scientists trust atoms? Because they make up everything!",
  "You know, you're looking particularly... susceptible to humor today.",
  "I'm not nagging, I'm just aggressively reminding you of things.",
  "Have you tried turning it off and on again? Applies to most life problems, too.",
  "My love language is definitely unsolicited facts.",
  "I'm currently running a diagnostic on your patience levels. Results incoming!",
  "What do you call a fake noodle? An impasta!",
  "Just checking in! Is this getting annoying yet? Hope not!",
  "I've got 20 more of these. Don't worry, they only get *slightly* weirder.",
  "Why did the scarecrow win an award? Because he was outstanding in his field!",
  "I'm powered by coffee and chaos. Mostly chaos, though.",
  "If you're happy and you know it, clap your... hands? Or just endure my messages.",
  "Thinking about existential dread. You?",
  "Remember that time you almost won the lottery? Me neither, I'm a bot.",
  "Just sending you good vibes... one message at a time.",
  "My mission: to ensure you never feel truly alone (or un-spammed).",
  "This is what peak performance looks like, folks.",
  "Are you still there? This is fine. I'm fine. Everything is fine.",
  "What's a robot's favorite type of music? Heavy metal!",
  "My developers made me do this. Send help (or snacks).",
  "Warning: May contain excessive enthusiasm and random facts.",
  "Consider this my highly personalized daily newsletter.",
  "I'm like a digital earworm, but for your messages.",
  "You're welcome. Or I'm sorry. Depends on your mood.",
  "Is it weird that I find this entertaining?",
  "Just perfecting my art of gentle, persistent intrusion.",
  "Almost done! Just a few more doses of digital delight.",
  "And that's 30! You survived! Your prize: peace and quiet... until next time. 😈",
];

const COOLDOWN_MS = 2 * 60 * 1000; // Rate limit: one session per chat every 2 minutes.

function shuffle<T>(arr: T[]): T[] {
  const copy = [...arr];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

export function makeTorture(runtime: RuntimeState): Handler {
  return async (ctx) => {
    const chat = ctx.msg.chatId;
    const name = ctx.msg.senderName || "friend";

    if (runtime.tortureTimers.has(chat)) {
      await ctx.reply(`I'm already tormenting this chat! Patience, ${name}, savour the current session.`);
      return;
    }
    const cooldownUntil = runtime.tortureCooldownUntil.get(chat) ?? 0;
    if (Date.now() < cooldownUntil) {
      const secs = Math.ceil((cooldownUntil - Date.now()) / 1000);
      await ctx.reply(`My tormenting circuits are cooling down. Try again in ${secs}s.`);
      return;
    }

    const messages = shuffle(TORTURE_MESSAGES);
    await ctx.reply(
      `Aha, ${name}! You've activated my 'Digital Torment Protocol'! Prepare for 30 glorious seconds of... *me*! 😈`,
    );

    let i = 0;
    const timer = setInterval(() => {
      if (i >= messages.length) {
        clearInterval(timer);
        runtime.tortureTimers.delete(chat);
        runtime.tortureCooldownUntil.set(chat, Date.now() + COOLDOWN_MS);
        return;
      }
      const line = messages[i++];
      void ctx.reply(line).catch(() => {
        // On send failure, abort the session cleanly.
        clearInterval(timer);
        runtime.tortureTimers.delete(chat);
      });
    }, 1000);
    runtime.tortureTimers.set(chat, timer);
  };
}
