import type { Logger } from "pino";
import type { Handler } from "../router/router.js";

// Audio (voice note) handler: download the buffer via Baileys and transcribe with Auralis.
// No context-menu clicking, no download directory — the media arrives as a buffer.
export function makeAudioHandler(logger: Logger): Handler {
  return async (ctx) => {
    const cfg = ctx.config;
    if (!cfg.audioDownloadEnabled) return;

    let buffer: Buffer;
    try {
      buffer = await ctx.downloadAudio();
    } catch (err) {
      logger.error({ err }, "Failed to download audio");
      return;
    }

    if (!(cfg.transcriptionEnabled && cfg.transcriptionProvider.toLowerCase() === "auralis")) {
      return;
    }

    const transcript = await transcribeWithAuralis(buffer, cfg.auralisBaseUrl, cfg.transcriptionTimeoutSeconds, logger);
    if (!transcript) {
      await ctx.quote("I could not get a transcription from Auralis right now.");
      return;
    }

    const quoted = transcript
      .split("\n")
      .map((line) => (line.trim() ? `> ${line}` : ">"))
      .join("\n");
    await ctx.quote(`Transcription of the last message:\n${quoted}`);
  };
}

async function transcribeWithAuralis(
  buffer: Buffer,
  baseUrl: string,
  timeoutSeconds: number,
  logger: Logger,
): Promise<string | null> {
  const endpoint = `${baseUrl.replace(/\/+$/, "")}/transcribe`;
  try {
    const form = new FormData();
    form.append("file", new Blob([buffer], { type: "audio/ogg" }), "voice.ogg");
    const res = await fetch(endpoint, {
      method: "POST",
      body: form,
      signal: AbortSignal.timeout(timeoutSeconds * 1000),
    });
    if (!res.ok) {
      logger.error({ status: res.status }, "Auralis returned non-OK");
      return null;
    }
    const payload = (await res.json()) as unknown;
    if (Array.isArray(payload)) {
      for (const item of payload) {
        if (item && typeof item === "object" && (item as { status?: string }).status === "ok") {
          const t = String((item as { transcript?: string }).transcript ?? "").trim();
          if (t) return t;
        }
      }
      return null;
    }
    if (payload && typeof payload === "object") {
      const t = String((payload as { transcript?: string }).transcript ?? "").trim();
      return t || null;
    }
    return null;
  } catch (err) {
    logger.error({ err }, "Auralis request failed");
    return null;
  }
}
