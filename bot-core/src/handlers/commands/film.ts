import type { Handler } from "../../router/router.js";
import { fetchVideo, queuePrompt, uploadImage, waitForVideo } from "./paint/comfy.js";
import { parseFilmModel } from "./film/parse.js";
import { buildMiniMaxFilmWorkflow, buildWanFilmWorkflow, buildWanTextFilmWorkflow } from "./film/workflows.js";

interface SourceDimensions {
  width: number;
  height: number;
}

function parseImageSize(image: Buffer): SourceDimensions | null {
  // PNG IHDR contains width/height as big-endian u32 at fixed offsets.
  if (image.length >= 24
    && image[0] === 0x89
    && image[1] === 0x50
    && image[2] === 0x4e
    && image[3] === 0x47) {
    const width = image.readUInt32BE(16);
    const height = image.readUInt32BE(20);
    if (width > 0 && height > 0) return { width, height };
  }

  // JPEG dimensions live in SOF markers.
  if (image.length >= 4 && image[0] === 0xff && image[1] === 0xd8) {
    let offset = 2;
    while (offset + 9 < image.length) {
      if (image[offset] !== 0xff) {
        offset += 1;
        continue;
      }
      const marker = image[offset + 1];
      if (marker === 0xd8 || marker === 0xd9) {
        offset += 2;
        continue;
      }
      const segmentLength = image.readUInt16BE(offset + 2);
      if (segmentLength < 2 || offset + 2 + segmentLength > image.length) break;
      const isSof = [0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker);
      if (isSof) {
        const height = image.readUInt16BE(offset + 5);
        const width = image.readUInt16BE(offset + 7);
        if (width > 0 && height > 0) return { width, height };
      }
      offset += 2 + segmentLength;
    }
  }

  return null;
}

async function runAndSendVideo(
  ctx: Parameters<Handler>[0],
  base: string,
  workflow: Record<string, unknown>,
  prompt: string,
): Promise<void> {
  const clientId = `whatsapp-bot-film-${Math.random().toString(36).slice(2)}`;
  const timeoutMs = Math.max(ctx.config.ollamaTimeoutSeconds, 1200) * 1000;
  const promptId = await queuePrompt(base, workflow, clientId);
  const ref = await waitForVideo(base, promptId, timeoutMs);
  const video = await fetchVideo(base, ref);
  await ctx.sendVideo(video, `🎬 ${prompt.slice(0, 180)}`);
}

// bot.film <prompt> — generate a short local video.
// Text-only prompts default to Wan text-to-video for speed.
export const film: Handler = async (ctx) => {
  const cfg = ctx.config;
  if (!cfg.paintEnabled) {
    await ctx.reply("Video generation is disabled. Enable local generation in Settings first.");
    return;
  }

  const prompt = ctx.args.trim();
  if (!prompt) {
    await ctx.reply(
      "Usage:\n• `bot.film <prompt>` — generate a short Wan text-to-video clip (default)\n• `bot.film minimax <prompt>` — explicit MiniMax H3\n• `bot.film wan <prompt>` — explicit Wan text-to-video\n• reply to a photo with `bot.film wan <prompt>` — Wan image-to-video anchor\n• `bot.film model=minimax <prompt>` — explicit selector form\nAll film workflows run locally on your configured ComfyUI backend.",
    );
    return;
  }

  const parsed = parseFilmModel(prompt);
  if (!parsed.text) {
    await ctx.reply("Add a video description after the model selector.");
    return;
  }

  const base = cfg.paintBaseUrl.replace(/\/+$/, "");
  const seed = Math.floor(Math.random() * 2 ** 31);
  let sourceName: string | null = null;
  let sourceSize: SourceDimensions | undefined;

  try {
    let quoted: Buffer | null = null;
    try {
      quoted = await ctx.getQuotedImage();
    } catch {
      await ctx.reply("Couldn't download the quoted photo. Please resend it or try again; no video was generated.");
      return;
    }
    if (quoted) {
      sourceName = await uploadImage(base, quoted, `bot-film-src-${seed}.png`);
      sourceSize = parseImageSize(quoted) ?? undefined;
    }

    // Default text-only prompts use Wan text-to-video for speed; quoted-image
    // Wan keeps the i2v path, and MiniMax remains opt-in.
    const workflow = parsed.model === "minimax"
      ? buildMiniMaxFilmWorkflow(parsed.text, seed, sourceName ? { imageName: sourceName, size: sourceSize } : undefined)
      : sourceName
        ? buildWanFilmWorkflow(parsed.text, seed, { imageName: sourceName, size: sourceSize })
        : buildWanTextFilmWorkflow(parsed.text, seed);

    await runAndSendVideo(ctx, base, workflow, parsed.text);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await ctx.reply(`Couldn't generate that video: ${msg}. Is ComfyUI running at ${cfg.paintBaseUrl}?`);
  }
};
