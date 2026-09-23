import type { Handler } from "../../router/router.js";
import { extractCommandToken } from "../../router/normalize.js";
import { parseGuidance, parseModel, parsePixelate, parseRestyle } from "./paint/parse.js";
import {
  buildFluxWorkflow,
  buildImg2ImgWorkflow,
  buildKontextWorkflow,
  buildPixelateWorkflow,
  buildRepaintPrompt,
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
  const name = await uploadImage(base, source, `bot-src-${seed}.png`);
  // "pixelate"/"8-bit" is a filter, not a style — apply it deterministically.
  const pix = parsePixelate(prompt);
  if (pix.pixelate) {
    await runAndSend(ctx, base, buildPixelateWorkflow(name, pix.factor), prompt);
    return;
  }
  const restyle = parseRestyle(prompt);
  // "hard"/"strong" → SDXL img2img (real repaint); otherwise Flux Kontext edit.
  if (restyle.hard) {
    const denoise = restyle.denoise ?? 0.7;
    const stylePrompt = buildRepaintPrompt(restyle.text);
    await runAndSend(ctx, base, buildImg2ImgWorkflow(ctx.config, stylePrompt, seed, name, denoise), restyle.text);
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
      "Usage:\n• `bot.paint a cozy cyberpunk alley at night` — create an image (SDXL)\n• add `flux` for far better complex-scene prompts, e.g. `bot.paint flux thor smashing the sagrada familia in a storm`\n• reply to a photo with `bot.paint <style/prompt>` — modify that photo\n• or send a photo captioned `bot.paint <prompt>`\n• add `g=4` to a photo edit for a stronger restyle (1=subtle, 4=bold)\n• add `hard` for a full painterly repaint (real Picasso/Monet look, less likeness); tune with `d=0.8`\n• reply to a photo with `bot.paint pixelate` for a real 8-bit blocky look (tune with `p=24`)",
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
    quoted = null;
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
    const { model, text } = parseModel(prompt);
    if (model === "flux") {
      const { guidance, text: fluxText } = parseGuidance(text, cfg.paintGuidance);
      await runAndSend(ctx, base, buildFluxWorkflow(cfg, fluxText, seed, guidance), fluxText);
    } else {
      await runAndSend(ctx, base, buildWorkflow(cfg, text, seed), text);
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
  const lower = token.toLowerCase();
  const trigger = Object.entries(cfg.commands).find(
    ([t, name]) => name === "paint" && lower.startsWith(t),
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
