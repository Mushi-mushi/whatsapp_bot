import type { Handler } from "../../router/router.js";
import type { BotConfig } from "../../config/schema.js";
import { extractCommandToken } from "../../router/normalize.js";

// ComfyUI txt2img workflow graph. Node ids are arbitrary strings; an input of
// the form [nodeId, outputIndex] wires one node's output into another.
function buildWorkflow(cfg: BotConfig, prompt: string, seed: number): Record<string, unknown> {
  return {
    "3": {
      class_type: "KSampler",
      inputs: {
        seed,
        steps: cfg.paintSteps,
        cfg: cfg.paintCfgScale,
        sampler_name: cfg.paintSampler,
        scheduler: cfg.paintScheduler,
        denoise: 1,
        model: ["4", 0],
        positive: ["6", 0],
        negative: ["7", 0],
        latent_image: ["5", 0],
      },
    },
    "4": { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: cfg.paintCheckpoint } },
    "5": {
      class_type: "EmptyLatentImage",
      inputs: { width: cfg.paintWidth, height: cfg.paintHeight, batch_size: 1 },
    },
    "6": { class_type: "CLIPTextEncode", inputs: { text: prompt, clip: ["4", 1] } },
    "7": { class_type: "CLIPTextEncode", inputs: { text: cfg.paintNegativePrompt, clip: ["4", 1] } },
    "8": { class_type: "VAEDecode", inputs: { samples: ["3", 0], vae: ["4", 2] } },
    "9": { class_type: "SaveImage", inputs: { filename_prefix: "bot", images: ["8", 0] } },
  };
}

// Flux txt2img via the all-in-one flux checkpoint. Flux is distilled (cfg=1, no
// real negative) and follows complex multi-subject prompts far better than SDXL,
// at the cost of speed. Uses a 16-channel SD3 latent and FluxGuidance.
function buildFluxWorkflow(
  cfg: BotConfig,
  prompt: string,
  seed: number,
  guidance: number,
): Record<string, unknown> {
  return {
    "4": { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: cfg.paintFluxCheckpoint } },
    "5": {
      class_type: "EmptySD3LatentImage",
      inputs: { width: cfg.paintWidth, height: cfg.paintHeight, batch_size: 1 },
    },
    "6": { class_type: "CLIPTextEncode", inputs: { text: prompt, clip: ["4", 1] } },
    "10": { class_type: "FluxGuidance", inputs: { conditioning: ["6", 0], guidance } },
    "7": { class_type: "CLIPTextEncode", inputs: { text: "", clip: ["4", 1] } },
    "3": {
      class_type: "KSampler",
      inputs: {
        seed,
        steps: cfg.paintSteps,
        cfg: 1,
        sampler_name: "euler",
        scheduler: "simple",
        denoise: 1,
        model: ["4", 0],
        positive: ["10", 0],
        negative: ["7", 0],
        latent_image: ["5", 0],
      },
    },
    "8": { class_type: "VAEDecode", inputs: { samples: ["3", 0], vae: ["4", 2] } },
    "9": { class_type: "SaveImage", inputs: { filename_prefix: "bot", images: ["8", 0] } },
  };
}

// SDXL img2img: re-generates the photo through an SDXL checkpoint at a high
// denoise so it truly repaints the scene (real painterly styles), unlike Kontext
// which only edits over the preserved photo. Higher denoise = stronger restyle,
// less likeness.
function buildImg2ImgWorkflow(
  cfg: BotConfig,
  prompt: string,
  seed: number,
  imageName: string,
  denoise: number,
): Record<string, unknown> {
  return {
    "3": {
      class_type: "KSampler",
      inputs: {
        seed,
        steps: cfg.paintSteps,
        cfg: cfg.paintCfgScale,
        sampler_name: cfg.paintSampler,
        scheduler: cfg.paintScheduler,
        denoise,
        model: ["4", 0],
        positive: ["6", 0],
        negative: ["7", 0],
        latent_image: ["11", 0],
      },
    },
    "4": { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: cfg.paintCheckpoint } },
    "6": { class_type: "CLIPTextEncode", inputs: { text: prompt, clip: ["4", 1] } },
    "7": { class_type: "CLIPTextEncode", inputs: { text: cfg.paintNegativePrompt, clip: ["4", 1] } },
    "8": { class_type: "VAEDecode", inputs: { samples: ["3", 0], vae: ["4", 2] } },
    "9": { class_type: "SaveImage", inputs: { filename_prefix: "bot", images: ["8", 0] } },
    "10": { class_type: "LoadImage", inputs: { image: imageName } },
    "11": { class_type: "VAEEncode", inputs: { pixels: ["10", 0], vae: ["4", 2] } },
  };
}

// look far better than a bare artist name, and won't shift the palette unless
// told to (hence the explicit colour cues).
const STYLE_HINTS: ReadonlyArray<{ re: RegExp; hint: string }> = [
  {
    re: /watercolou?r/i,
    hint: "Watercolor painting, hand-painted illustration, visible translucent pigment washes, paper grain, expressive brushwork, soft bleeding edges, and simplified painted details.",
  },
  {
    re: /monet|impressionis/i,
    hint: "Impressionist oil painting in the style of Claude Monet: soft dappled natural light, feathery broken brushstrokes, hazy blurred edges, and a plein-air atmosphere. Recolour the whole image into a soft muted pastel palette of gentle blues, greens, lavender and pale pink — remove any harsh saturated colours.",
  },
  {
    re: /picasso|cubis/i,
    hint: "Cubist painting in the style of Pablo Picasso: the subject fragmented into flat angular geometric planes, several viewpoints shown at once, bold outlines, and abstracted simplified forms.",
  },
  {
    re: /van ?gogh/i,
    hint: "Post-impressionist oil painting in the style of Vincent van Gogh: thick swirling impasto brushstrokes, dynamic flowing lines, and vivid expressive colour with a starry-night energy.",
  },
];

function buildRepaintPrompt(prompt: string): string {
  const hint = STYLE_HINTS.find((s) => s.re.test(prompt))?.hint ?? "";
  return `${hint} Keep the same subject, species, pose, and composition as the source photo, but fully and boldly restyle the entire image as requested — apply the look thoroughly across every part of the picture, not as a subtle filter: ${prompt}.`;
}

function buildKontextWorkflow(
  prompt: string,
  seed: number,
  imageName: string,
  guidance: number,
): Record<string, unknown> {
  return {
    "1": { class_type: "LoadImage", inputs: { image: imageName } },
    "2": {
      class_type: "FluxKontextImageScale",
      inputs: {
        image: ["1", 0],
        upscale_method: "nearest-exact",
        width: 0,
        height: 0,
        crop: "disabled",
      },
    },
    "3": {
      class_type: "UNETLoader",
      inputs: { unet_name: "flux1-dev-kontext_fp8_scaled.safetensors", weight_dtype: "default" },
    },
    "4": {
      class_type: "DualCLIPLoader",
      inputs: {
        clip_name1: "clip_l.safetensors",
        clip_name2: "t5xxl_fp8_e4m3fn_scaled.safetensors",
        type: "flux",
        device: "default",
      },
    },
    "5": { class_type: "VAELoader", inputs: { vae_name: "ae.safetensors" } },
    "6": { class_type: "CLIPTextEncode", inputs: { text: prompt, clip: ["4", 0] } },
    "7": { class_type: "ConditioningZeroOut", inputs: { conditioning: ["6", 0] } },
    "8": { class_type: "VAEEncode", inputs: { pixels: ["2", 0], vae: ["5", 0] } },
    "9": {
      class_type: "ReferenceLatent",
      inputs: { conditioning: ["6", 0], latent: ["8", 0] },
    },
    "10": { class_type: "FluxGuidance", inputs: { conditioning: ["9", 0], guidance } },
    "11": {
      class_type: "KSampler",
      inputs: {
        seed,
        steps: 20,
        cfg: 1,
        sampler_name: "euler",
        scheduler: "simple",
        denoise: 1,
        model: ["3", 0],
        positive: ["10", 0],
        negative: ["7", 0],
        latent_image: ["8", 0],
      },
    },
    "12": { class_type: "VAEDecode", inputs: { samples: ["11", 0], vae: ["5", 0] } },
    "13": { class_type: "SaveImage", inputs: { filename_prefix: "bot", images: ["12", 0] } },
  };
}

interface ComfyImageRef {
  filename: string;
  subfolder: string;
  type: string;
}

interface HistoryEntry {
  outputs?: Record<string, { images?: ComfyImageRef[] }>;
  status?: { status_str?: string };
}

async function queuePrompt(base: string, workflow: Record<string, unknown>, clientId: string): Promise<string> {
  const res = await fetch(`${base}/prompt`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    signal: AbortSignal.timeout(15_000),
    body: JSON.stringify({ prompt: workflow, client_id: clientId }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`queue failed (${res.status})${detail ? `: ${detail.slice(0, 200)}` : ""}`);
  }
  const data = (await res.json()) as { prompt_id?: string };
  if (!data.prompt_id) throw new Error("no prompt_id returned");
  return data.prompt_id;
}

// Upload a source photo into ComfyUI's input folder for img2img; returns the
// name to reference from a LoadImage node.
async function uploadImage(base: string, image: Buffer, filename: string): Promise<string> {
  const form = new FormData();
  form.append("image", new Blob([new Uint8Array(image)]), filename);
  form.append("type", "input");
  form.append("overwrite", "true");
  const res = await fetch(`${base}/upload/image`, {
    method: "POST",
    body: form,
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`image upload failed (${res.status})`);
  const data = (await res.json()) as { name?: string; subfolder?: string };
  if (!data.name) throw new Error("upload returned no name");
  return data.subfolder ? `${data.subfolder}/${data.name}` : data.name;
}

// Poll history until the prompt produces an output image (or times out).
async function waitForImage(base: string, promptId: string, timeoutMs: number): Promise<ComfyImageRef> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await fetch(`${base}/history/${promptId}`, { signal: AbortSignal.timeout(10_000) });
    if (res.ok) {
      const hist = (await res.json()) as Record<string, HistoryEntry>;
      const entry = hist[promptId];
      if (entry?.outputs) {
        for (const out of Object.values(entry.outputs)) {
          const img = out.images?.find((i) => i.type === "output") ?? out.images?.[0];
          if (img) return img;
        }
        if (entry.status?.status_str === "error") throw new Error("generation failed in ComfyUI");
      }
    }
    await new Promise((r) => setTimeout(r, 1200));
  }
  throw new Error("timed out waiting for the image");
}

async function fetchImage(base: string, ref: ComfyImageRef): Promise<Buffer> {
  const params = new URLSearchParams({
    filename: ref.filename,
    subfolder: ref.subfolder ?? "",
    type: ref.type ?? "output",
  });
  const res = await fetch(`${base}/view?${params.toString()}`, { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`fetch image failed (${res.status})`);
  return Buffer.from(await res.arrayBuffer());
}

// Queue a workflow, wait for the result, and send it back to the chat.
async function runAndSend(
  ctx: Parameters<Handler>[0],
  base: string,
  workflow: Record<string, unknown>,
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

// Deterministic pixelation (no diffusion): downscale with area averaging, then
// upscale back to the original size with nearest-neighbour so it becomes real
// blocks. Higher factor = chunkier blocks.
function buildPixelateWorkflow(imageName: string, factor: number): Record<string, unknown> {
  return {
    "1": { class_type: "LoadImage", inputs: { image: imageName } },
    "2": { class_type: "GetImageSize", inputs: { image: ["1", 0] } },
    "3": {
      class_type: "ImageScaleBy",
      inputs: { image: ["1", 0], upscale_method: "area", scale_by: 1 / factor },
    },
    "4": {
      class_type: "ImageScale",
      inputs: {
        image: ["3", 0],
        upscale_method: "nearest-exact",
        width: ["2", 0],
        height: ["2", 1],
        crop: "disabled",
      },
    },
    "5": { class_type: "SaveImage", inputs: { filename_prefix: "bot", images: ["4", 0] } },
  };
}

// Optional inline override in the prompt, e.g. "g=4" or "guidance=4"; returns
// the clamped value plus the prompt with that token removed.
function parseGuidance(prompt: string, fallback: number): { guidance: number; text: string } {
  const m = prompt.match(/\b(?:g|guidance)\s*=\s*(\d+(?:\.\d+)?)\b/i);
  if (!m) return { guidance: fallback, text: prompt };
  const guidance = Math.min(10, Math.max(1, Number(m[1])));
  const text = prompt.replace(m[0], "").replace(/\s{2,}/g, " ").trim();
  return { guidance, text };
}

// Detect a "pixelate"/"8-bit" request and optional "p=24" block factor.
function parsePixelate(prompt: string): { pixelate: boolean; factor: number } {
  const pixelate = /\bpixel(?:ate|ated|ize|ized|ised|s)?\b|\b8-?bit\b/i.test(prompt);
  const pm = prompt.match(/\bp\s*=\s*(\d{1,3})\b/i);
  const factor = pm ? Math.min(64, Math.max(6, Number(pm[1]))) : 24;
  return { pixelate, factor };
}

// Detect a "hard"/"strong" restyle flag and optional "d=0.7"/"denoise=0.7"
// override; strips both tokens from the prompt.
function parseRestyle(prompt: string): { hard: boolean; denoise: number | null; text: string } {
  let text = prompt;
  const hard = /\b(?:hard|strong)\b/i.test(text);
  if (hard) text = text.replace(/\b(?:hard|strong)\b/i, "");
  const dm = text.match(/\b(?:d|denoise)\s*=\s*(0?\.\d+|1(?:\.0+)?)\b/i);
  let denoise: number | null = null;
  if (dm) {
    denoise = Math.min(1, Math.max(0.1, Number(dm[1])));
    text = text.replace(dm[0], "");
  }
  return { hard, denoise, text: text.replace(/\s{2,}/g, " ").trim() };
}

// Pick the generation model from the prompt: `flux`/`flux1` → Flux, else SDXL.
function parseModel(prompt: string): { model: "flux" | "sdxl"; text: string } {
  let text = prompt;
  let model: "flux" | "sdxl" = "sdxl";
  if (/\bflux1?\b/i.test(text)) {
    model = "flux";
    text = text.replace(/\bflux1?\b/i, "");
  } else if (/\bsdxl\b/i.test(text)) {
    text = text.replace(/\bsdxl\b/i, "");
  }
  return { model, text: text.replace(/\s{2,}/g, " ").trim() };
}

// Upload a source photo and run img2img on it.
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
