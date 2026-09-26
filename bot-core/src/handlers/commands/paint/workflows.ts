import type { BotConfig } from "../../../config/schema.js";

// A ComfyUI workflow graph: node ids are arbitrary strings; an input of the form
// [nodeId, outputIndex] wires one node's output into another.
export type Workflow = Record<string, unknown>;

export const AMANESSE_PRESET = {
  checkpoint: "amanesseWorks_v20.safetensors",
  negativePrompt: "lowres, worst quality, bad quality, bad anatomy, bad eyes, bad hands, missing fingers, bad feet, missing toes, 4 toes, artifact, signature, watermark, simple background, nsfw, nude",
  loras: [
    { name: "96YOTTEA-WAI.safetensors", strength: 0.5 },
    { name: "Rapscallion_Illustrious.safetensors", strength: 0.1 },
    { name: "ppw_v8_Illuv2stable_128.safetensors", strength: 0.4 },
    { name: "venus_body_ILXL_v2.safetensors", strength: 2.5 },
    { name: "niji_and_midj_mix217.safetensors", strength: 0.4 },
  ],
} as const;

export function buildAmanesseWorkflow(
  cfg: BotConfig,
  prompt: string,
  seed: number,
  source?: { imageName: string; denoise: number },
): Workflow {
  const settings = {
    ...cfg,
    paintCheckpoint: AMANESSE_PRESET.checkpoint,
    paintWidth: 832,
    paintHeight: 1216,
    paintSteps: 30,
    paintCfgScale: 7,
    paintSampler: "dpmpp_2m",
    paintScheduler: "karras",
    paintNegativePrompt: AMANESSE_PRESET.negativePrompt,
  };
  const text = /\bRapscallionstyle\b/i.test(prompt) ? prompt : `Rapscallionstyle, ${prompt}`;
  const workflow = source
    ? buildImg2ImgWorkflow(settings, text, seed, source.imageName, source.denoise)
    : buildWorkflow(settings, text, seed);
  let model: [string, number] = ["4", 0];
  let clip: [string, number] = ["4", 1];
  AMANESSE_PRESET.loras.forEach((lora, index) => {
    const nodeId = String(20 + index);
    workflow[nodeId] = {
      class_type: "LoraLoader",
      inputs: { model, clip, lora_name: lora.name, strength_model: lora.strength, strength_clip: lora.strength },
    };
    model = [nodeId, 0];
    clip = [nodeId, 1];
  });
  workflow["25"] = { class_type: "CLIPSetLastLayer", inputs: { clip, stop_at_clip_layer: -2 } };
  workflow["6"] = { class_type: "CLIPTextEncode", inputs: { text, clip: ["25", 0] } };
  workflow["7"] = { class_type: "CLIPTextEncode", inputs: { text: settings.paintNegativePrompt, clip: ["25", 0] } };
  workflow["3"] = {
    class_type: "KSampler",
    inputs: {
      seed, steps: 30, cfg: 7, sampler_name: "dpmpp_2m", scheduler: "karras",
      denoise: source?.denoise ?? 1, model, positive: ["6", 0], negative: ["7", 0],
      latent_image: [source ? "11" : "5", 0],
    },
  };
  return workflow;
}

// SDXL txt2img.
export function buildWorkflow(
  cfg: BotConfig,
  prompt: string,
  seed: number,
  checkpointOverride?: string,
): Workflow {
  const checkpoint = checkpointOverride?.trim() || cfg.paintCheckpoint;
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
    "4": { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: checkpoint } },
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
export function buildFluxWorkflow(
  cfg: BotConfig,
  prompt: string,
  seed: number,
  guidance: number,
  source?: { imageName: string; denoise: number },
): Workflow {
  return {
    "4": { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: cfg.paintFluxCheckpoint } },
    "5": source ? {
      class_type: "VAEEncode",
      inputs: { pixels: ["11", 0], vae: ["4", 2] },
    } : {
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
        denoise: source?.denoise ?? 1,
        model: ["4", 0],
        positive: ["10", 0],
        negative: ["7", 0],
        latent_image: ["5", 0],
      },
    },
    "8": { class_type: "VAEDecode", inputs: { samples: ["3", 0], vae: ["4", 2] } },
    "9": { class_type: "SaveImage", inputs: { filename_prefix: "bot", images: ["8", 0] } },
    ...(source ? { "11": { class_type: "LoadImage", inputs: { image: source.imageName } } } : {}),
  };
}

// SDXL img2img: re-generates the photo through an SDXL checkpoint at a high
// denoise so it truly repaints the scene (real painterly styles), unlike Kontext
// which only edits over the preserved photo. Higher denoise = stronger restyle,
// less likeness.
export function buildImg2ImgWorkflow(
  cfg: BotConfig,
  prompt: string,
  seed: number,
  imageName: string,
  denoise: number,
  checkpointOverride?: string,
): Workflow {
  const checkpoint = checkpointOverride?.trim() || cfg.paintCheckpoint;
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
    "4": { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: checkpoint } },
    "6": { class_type: "CLIPTextEncode", inputs: { text: prompt, clip: ["4", 1] } },
    "7": { class_type: "CLIPTextEncode", inputs: { text: cfg.paintNegativePrompt, clip: ["4", 1] } },
    "8": { class_type: "VAEDecode", inputs: { samples: ["3", 0], vae: ["4", 2] } },
    "9": { class_type: "SaveImage", inputs: { filename_prefix: "bot", images: ["8", 0] } },
    "10": { class_type: "LoadImage", inputs: { image: imageName } },
    "11": { class_type: "VAEEncode", inputs: { pixels: ["10", 0], vae: ["4", 2] } },
  };
}

// Rich style descriptors: a bare artist name gives weak Kontext results, and
// Kontext keeps the source palette unless told otherwise (hence the colour cues).
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

export function buildRepaintPrompt(prompt: string): string {
  const hint = STYLE_HINTS.find((s) => s.re.test(prompt))?.hint ?? "";
  return `${hint} Keep the same subject, species, pose, and composition as the source photo, but fully and boldly restyle the entire image as requested — apply the look thoroughly across every part of the picture, not as a subtle filter: ${prompt}.`;
}

// Flux Kontext edit: anchors geometry to the reference photo and applies the
// style/edit prompt over it.
export function buildKontextWorkflow(
  prompt: string,
  seed: number,
  imageName: string,
  guidance: number,
): Workflow {
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

// Deterministic pixelation (no diffusion): downscale with area averaging, then
// upscale back to the original size with nearest-neighbour so it becomes real
// blocks. Higher factor = chunkier blocks.
export function buildPixelateWorkflow(imageName: string, factor: number): Workflow {
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
