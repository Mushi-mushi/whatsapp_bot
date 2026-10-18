import type { Handler } from "../../router/router.js";
import { extractCommandToken, matchesCommand } from "../../router/normalize.js";
import { parseGuidance, parseModel, parsePixelate, parseRestyle } from "./paint/parse.js";
import {
  buildAmanesseWorkflow,
  buildFluxWorkflow,
  buildImg2ImgWorkflow,
  buildKontextWorkflow,
  buildPixelateWorkflow,
  buildRepaintPrompt,
  buildRetroAnimeWorkflow,
  buildWorkflow,
  type Workflow,
} from "./paint/workflows.js";
import { fetchImage, queuePrompt, uploadImage, waitForImage } from "./paint/comfy.js";

// Queue a workflow, wait for the result, and send it back to the chat.
async function runAndSend(
  ctx: Parameters<Handler>[0],
  base: string,
  workflow: Workflow,
  prompt: string,
): Promise<void> {
  const clientId = `whatsapp-bot-${Math.random().toString(36).slice(2)}`;
  // Flux Kontext edits load large models on first use; allow a generous wait.
  const timeoutMs = Math.max(ctx.config.ollamaTimeoutSeconds, 600) * 1000;
  const promptId = await queuePrompt(base, workflow, clientId);
  const ref = await waitForImage(base, promptId, timeoutMs);
  const image = await fetchImage(base, ref);
  await ctx.sendImage(image, `🖼️ ${prompt.slice(0, 180)}`);
}

// Upload a source photo and run the right img2img flow on it.
async function repaint(
  ctx: Parameters<Handler>[0],
  base: string,
  prompt: string,
  seed: number,
  source: Buffer,
): Promise<void> {
  const parsed = parseModel(prompt);
  if (parsed.model === "wan") {
    await ctx.reply("Wan is not available for local still-image editing in this bot. Your installed Wan models are video models. Choose sdxl, hunyuan, flux, or a compatible checkpoint.");
    return;
  }
  const usesFlux = parsed.model === "flux" || parsed.checkpoint === ctx.config.paintFluxCheckpoint;
  if (!parsed.text) {
    await ctx.reply("Add an image description or edit instruction after the model selector.");
    return;
  }
  const promptBody = parsed.text;
  const name = await uploadImage(base, source, `bot-src-${seed}.png`);
  // "pixelate"/"8-bit" is a filter, not a style — apply it deterministically.
  const pix = parsePixelate(promptBody);
  if (pix.pixelate) {
    await runAndSend(ctx, base, buildPixelateWorkflow(name, pix.factor), promptBody);
    return;
  }
  const restyle = parseRestyle(promptBody);
  if (parsed.selected || restyle.hard) {
    const denoise = restyle.denoise ?? (restyle.hard ? 0.7 : ctx.config.paintDenoise);
    const stylePrompt = buildRepaintPrompt(restyle.text);
    const { guidance, text } = parseGuidance(stylePrompt, ctx.config.paintGuidance);
    if (parsed.model === "amanesse") {
      await runAndSend(ctx, base, buildAmanesseWorkflow(ctx.config, text, seed, { imageName: name, denoise }), restyle.text);
      return;
    }
    if (parsed.model === "retroanime") {
      await runAndSend(ctx, base, buildRetroAnimeWorkflow(text, seed, { imageName: name, denoise }), restyle.text);
      return;
    }
    await runAndSend(
      ctx,
      base,
      usesFlux
        ? buildFluxWorkflow(ctx.config, text, seed, guidance, { imageName: name, denoise })
        : buildImg2ImgWorkflow(ctx.config, text, seed, name, denoise, parsed.checkpoint ?? undefined),
      restyle.text,
    );
    return;
  }
  const { guidance, text } = parseGuidance(restyle.text, ctx.config.paintGuidance);
  const repaintPrompt = buildRepaintPrompt(text);
  await runAndSend(ctx, base, buildKontextWorkflow(repaintPrompt, seed, name, guidance), text);
}

// bot.paint <prompt> — generate an image, or (if replying to a photo) modify it.
export const paint: Handler = async (ctx) => {
  const cfg = ctx.config;
  if (!cfg.paintEnabled) {
    await ctx.reply("Image generation is disabled. Enable it in Settings first.");
    return;
  }

  const prompt = ctx.args.trim();
  if (!prompt) {
    await ctx.reply(
      "Usage:\n• `bot.paint <prompt>` — create an image with the default checkpoint\n• `bot.paint sdxl|flux|hunyuan|pony <prompt>` — select a local model\n• `bot.paint amanesse <prompt>` — Amanesse + five-LoRA illustration preset\n• `bot.paint retroanime <prompt>` — Retro Anime Flux + three-LoRA style preset\n• `bot.paint model=yourModel.safetensors <prompt>` — choose a compatible checkpoint (quote filenames containing spaces)\n• reply to a photo or caption one with `bot.paint <edit>` — Flux Kontext edit\n• include a model selector to repaint with that model; tune strength with `d=0.7`\n• `hard` uses stronger denoising (default 0.7)\n• `g=4` tunes Flux guidance (presets use fixed settings)\n• `pixelate p=24` applies a deterministic photo filter\n• Wan video models are not supported for local paint; cloud APIs are disabled.",
    );
    return;
  }

  const base = cfg.paintBaseUrl.replace(/\/+$/, "");
  const seed = Math.floor(Math.random() * 2 ** 31);

  // If this message replies to an image, modify that image (img2img).
  let quoted: Buffer | null = null;
  try {
    quoted = await ctx.getQuotedImage();
  } catch {
    await ctx.reply("Couldn't download the quoted photo. Please resend it or try again; no new image was generated.");
    return;
  }
  if (quoted) {
    try {
      await repaint(ctx, base, prompt, seed, quoted);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await ctx.reply(`Couldn't repaint that: ${msg}. Is ComfyUI running at ${cfg.paintBaseUrl}?`);
    }
    return;
  }

  try {
    const { model, text, checkpoint } = parseModel(prompt);
    if (!text) {
      await ctx.reply("Add an image description after the model selector.");
      return;
    }
    if (model === "amanesse") {
      await runAndSend(ctx, base, buildAmanesseWorkflow(cfg, text, seed), text);
    } else if (model === "retroanime") {
      await runAndSend(ctx, base, buildRetroAnimeWorkflow(text, seed), text);
    } else if (model === "flux" || checkpoint === cfg.paintFluxCheckpoint) {
      const { guidance, text: fluxText } = parseGuidance(text, cfg.paintGuidance);
      await runAndSend(ctx, base, buildFluxWorkflow(cfg, fluxText, seed, guidance), fluxText);
    } else if (model === "wan") {
      await ctx.reply("Wan is not available for local still-image generation in this bot. The Wan text-to-image node uses a paid cloud API, which is disabled. Choose sdxl, hunyuan, flux, or a compatible checkpoint.");
    } else {
      await runAndSend(ctx, base, buildWorkflow(cfg, text, seed, checkpoint ?? undefined), text);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await ctx.reply(`Couldn't paint that: ${msg}. Is ComfyUI running at ${cfg.paintBaseUrl}?`);
  }
};

// Image kind handler: a photo captioned `bot.paint <prompt>` runs img2img on it.
export const paintImage: Handler = async (ctx) => {
  const cfg = ctx.config;
  const token = extractCommandToken(ctx.text);
  if (!token) return;
  const trigger = Object.entries(cfg.commands).find(
    ([t, name]) => name === "paint" && matchesCommand(token, t),
  )?.[0];
  if (!trigger) return;

  if (!cfg.paintEnabled) {
    await ctx.reply("Image generation is disabled. Enable it in Settings first.");
    return;
  }
  const prompt = token.slice(trigger.length).trim();
  if (!prompt) {
    await ctx.reply("Add a prompt — send the photo captioned e.g. `bot.paint turn this into a watercolor`.");
    return;
  }

  const base = cfg.paintBaseUrl.replace(/\/+$/, "");
  const seed = Math.floor(Math.random() * 2 ** 31);
  try {
    const source = await ctx.downloadImage();
    await repaint(ctx, base, prompt, seed, source);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await ctx.reply(`Couldn't repaint that: ${msg}. Is ComfyUI running at ${cfg.paintBaseUrl}?`);
  }
};
