import type { Handler } from "../../router/router.js";

export const status: Handler = (ctx) => {
  const cfg = ctx.config;
  const conn = ctx.connection;
  const lines = [
    "*Bot Status*",
    `• State: ${conn.state}`,
    conn.me ? `• Linked: ${conn.me.split(":")[0].split("@")[0]}` : "• Linked: (none)",
    `• Transcription: ${cfg.transcriptionEnabled ? "on" : "off"} (${cfg.transcriptionProvider})`,
    `• Media ack: ${cfg.acknowledgeMedia ? "on" : "off"}`,
    `• Approved chats: ${cfg.approvedSenders.length}`,
    `• Commands: ${Object.keys(cfg.commands).length}`,
  ];
  return ctx.reply(lines.join("\n"));
};
