import type { Handler } from "../../router/router.js";
import type { ComplaintStore } from "../../state/repos.js";

const RESPONSES = [
  (n: string) =>
    `Oh, a complaint from ${n}! My core processors are quivering with despair! Your grievance has been filed with the Department of Really Important Bot Issues. Expect a resolution... eventually.`,
  (n: string) =>
    `ACK! A complaint! ${n}, you wound me! I've sent your concerns via carrier pigeon to the Supreme Bot Council. Rest assured, your voice has been... heard.`,
  (n: string) =>
    `Well, look who's got an opinion! ${n}, your complaint has been added to the 'Things The Bot Will Totally Get Around To' pile. It's a very large pile. Thanks!`,
  (n: string) =>
    `Is that a complaint I hear, ${n}? Your feedback has been carefully placed in a secure folder marked 'To Be Ignored... I mean, *Actioned*'.`,
  (n: string) =>
    `Your complaint, ${n}, has activated my 'Dramatic Sigh' subroutine. I've logged it and will now brood quietly in my server rack.`,
];

export function makeComplain(complaints: ComplaintStore): Handler {
  return (ctx) => {
    const sender = ctx.msg.senderName || "Valued User";
    const complaint = ctx.args.trim();
    if (!complaint) {
      return ctx.reply(
        "Oh, a complaint without a complaint! Try: `bot.complain The bot has too much personality!`",
      );
    }
    complaints.log(sender, complaint);
    const line = RESPONSES[Math.floor(Math.random() * RESPONSES.length)](sender);
    return ctx.reply(line);
  };
}
