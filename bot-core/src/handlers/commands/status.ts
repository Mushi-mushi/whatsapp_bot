import type { Handler } from "../../router/router.js";

async function probeService(url: string): Promise<{ reachable: boolean; detail: string }> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (res.ok) return { reachable: true, detail: "reachable" };
    // Any HTTP response means the host is reachable, even when this endpoint errors.
    return { reachable: true, detail: `reachable (HTTP ${res.status})` };
  } catch (err) {
    const name = err instanceof Error ? err.name : "Error";
    if (name === "TimeoutError") return { reachable: false, detail: "timeout" };
    return { reachable: false, detail: "unreachable" };
  }
}

export const status: Handler = async (ctx) => {
  const cfg = ctx.config;
  const conn = ctx.connection;
  const ollamaBase = cfg.ollamaBaseUrl.replace(/\/+$/, "");
  const comfyBase = cfg.paintBaseUrl.replace(/\/+$/, "");
  const [ollama, comfy] = await Promise.all([
    probeService(`${ollamaBase}/api/tags`),
    probeService(`${comfyBase}/queue`),
  ]);
  const ollamaState = ollama.reachable ? "OK" : "FAIL";
  const comfyState = comfy.reachable ? "OK" : "FAIL";
  const lines = [
    "*Bot Status*",
    `• State: ${conn.state}`,
    conn.me ? `• Linked: ${conn.me.split(":")[0].split("@")[0]}` : "• Linked: (none)",
    `• Transcription: ${cfg.transcriptionEnabled ? "on" : "off"} (${cfg.transcriptionProvider})`,
    `• Media ack: ${cfg.acknowledgeMedia ? "on" : "off"}`,
    `• Ollama: ${ollamaState} - ${ollama.detail} (${ollamaBase})`,
    `• ComfyUI: ${comfyState} - ${comfy.detail} (${comfyBase})`,
    `• Approved chats: ${cfg.approvedSenders.length}`,
    `• Commands: ${Object.keys(cfg.commands).length}`,
  ];
  return ctx.reply(lines.join("\n"));
};
