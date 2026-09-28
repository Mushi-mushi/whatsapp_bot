import type { Workflow } from "../paint/workflows.js";

const FILM_NEGATIVE = "low quality, blurry, artifact, watermark, text, still image, frozen frame, no motion";

interface SourceDimensions {
  width: number;
  height: number;
}

function fitToAspect(
  source: SourceDimensions,
  shortEdge: number,
  maxPixels: number,
  multiple = 32,
): { width: number; height: number } {
  const ratio = source.width / source.height;
  let width = ratio >= 1 ? shortEdge * ratio : shortEdge;
  let height = ratio >= 1 ? shortEdge : shortEdge / ratio;

  if (width * height > maxPixels) {
    const scale = Math.sqrt(maxPixels / (width * height));
    width *= scale;
    height *= scale;
  }

  const snappedWidth = Math.max(multiple, Math.round(width / multiple) * multiple);
  const snappedHeight = Math.max(multiple, Math.round(height / multiple) * multiple);
  return { width: snappedWidth, height: snappedHeight };
}

function addMotionBias(prompt: string): string {
  const hasMotionCue = /\b(motion|moving|camera|pan|tilt|dolly|tracking|zoom|timelapse|wind|waves|ripples|drift|flow|animate)\b/i.test(prompt);
  if (hasMotionCue) return prompt;
  return `${prompt}, subtle camera motion, natural environmental movement, temporal coherence`;
}

export function buildWanFilmWorkflow(
  prompt: string,
  seed: number,
  source?: { imageName: string; size?: SourceDimensions },
): Workflow {
  const sized = source?.size
    ? fitToAspect(source.size, 480, 832 * 480, 16)
    : { width: 832, height: 480 };
  return {
    "1": {
      class_type: "CLIPLoader",
      inputs: { clip_name: "umt5_xxl_fp8_e4m3fn_scaled.safetensors", type: "wan", device: "default" },
    },
    "2": { class_type: "CLIPTextEncode", inputs: { text: addMotionBias(prompt), clip: ["1", 0] } },
    "3": { class_type: "CLIPTextEncode", inputs: { text: FILM_NEGATIVE, clip: ["1", 0] } },
    "4": { class_type: "VAELoader", inputs: { vae_name: "wan_2.1_vae.safetensors" } },
    "5": {
      class_type: "WanImageToVideo",
      inputs: {
        positive: ["2", 0],
        negative: ["3", 0],
        vae: ["4", 0],
        width: sized.width,
        height: sized.height,
        length: 81,
        batch_size: 1,
        ...(source ? { start_image: ["15", 0] } : {}),
      },
    },
    "6": {
      class_type: "UNETLoader",
      inputs: { unet_name: "wan2.2_i2v_high_noise_14B_fp8_scaled.safetensors", weight_dtype: "default" },
    },
    "7": {
      class_type: "UNETLoader",
      inputs: { unet_name: "wan2.2_i2v_low_noise_14B_fp8_scaled.safetensors", weight_dtype: "default" },
    },
    "8": { class_type: "ModelSamplingSD3", inputs: { model: ["6", 0], shift: 5 } },
    "9": { class_type: "ModelSamplingSD3", inputs: { model: ["7", 0], shift: 5 } },
    "10": {
      class_type: "KSamplerAdvanced",
      inputs: {
        model: ["8", 0],
        add_noise: "enable",
        noise_seed: seed,
        steps: 20,
        cfg: 1,
        sampler_name: "euler",
        scheduler: "beta",
        positive: ["5", 0],
        negative: ["5", 1],
        latent_image: ["5", 2],
        start_at_step: 0,
        end_at_step: 10,
        return_with_leftover_noise: "enable",
      },
    },
    "11": {
      class_type: "KSamplerAdvanced",
      inputs: {
        model: ["9", 0],
        add_noise: "disable",
        noise_seed: seed,
        steps: 20,
        cfg: 1,
        sampler_name: "euler",
        scheduler: "beta",
        positive: ["5", 0],
        negative: ["5", 1],
        latent_image: ["10", 0],
        start_at_step: 10,
        end_at_step: 20,
        return_with_leftover_noise: "disable",
      },
    },
    "12": { class_type: "VAEDecode", inputs: { samples: ["11", 0], vae: ["4", 0] } },
    "13": { class_type: "CreateVideo", inputs: { images: ["12", 0], fps: 24 } },
    "14": { class_type: "SaveVideo", inputs: { video: ["13", 0], filename_prefix: "bot-film", format: "mp4", codec: "h264" } },
    ...(source ? { "15": { class_type: "LoadImage", inputs: { image: source.imageName } } } : {}),
  };
}

export function buildWanTextFilmWorkflow(
  prompt: string,
  seed: number,
): Workflow {
  return {
    "1": {
      class_type: "UNETLoader",
      inputs: { unet_name: "wan2.1_t2v_1.3b_fp16.safetensors", weight_dtype: "default" },
    },
    "2": {
      class_type: "CLIPLoader",
      inputs: { clip_name: "umt5_xxl_fp8_e4m3fn_scaled.safetensors", type: "wan", device: "default" },
    },
    "3": { class_type: "VAELoader", inputs: { vae_name: "wan_2.1_vae.safetensors" } },
    "4": { class_type: "CLIPTextEncode", inputs: { text: addMotionBias(prompt), clip: ["2", 0] } },
    "5": { class_type: "CLIPTextEncode", inputs: { text: FILM_NEGATIVE, clip: ["2", 0] } },
    "6": {
      class_type: "EmptyHunyuanLatentVideo",
      inputs: { width: 832, height: 480, length: 65, batch_size: 1 },
    },
    "7": { class_type: "ModelSamplingSD3", inputs: { model: ["1", 0], shift: 8 } },
    "8": {
      class_type: "KSampler",
      inputs: {
        seed,
        steps: 30,
        cfg: 6,
        sampler_name: "uni_pc",
        scheduler: "simple",
        denoise: 1,
        model: ["7", 0],
        positive: ["4", 0],
        negative: ["5", 0],
        latent_image: ["6", 0],
      },
    },
    "9": { class_type: "VAEDecode", inputs: { samples: ["8", 0], vae: ["3", 0] } },
    "10": { class_type: "CreateVideo", inputs: { images: ["9", 0], fps: 16 } },
    "11": { class_type: "SaveVideo", inputs: { video: ["10", 0], filename_prefix: "bot-film", format: "mp4", codec: "h264" } },
  };
}

export function buildMiniMaxFilmWorkflow(
  prompt: string,
  seed: number,
  source?: { imageName: string; size?: SourceDimensions },
): Workflow {
  const sized = source?.size
    ? fitToAspect(source.size, 768, 768 * 1344)
    : { width: 768, height: 448 };
  return {
    "1": {
      class_type: "UNETLoader",
      inputs: { unet_name: "minimax_h3_fl2va_pruned_int8_convrot.safetensors", weight_dtype: "default" },
    },
    "2": { class_type: "MiniMaxH3SigmaShift", inputs: { model: ["1", 0], shift_video: 12, shift_audio: 3 } },
    "3": {
      class_type: "CLIPLoader",
      inputs: { clip_name: "qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors", type: "minimax", device: "default" },
    },
    "4": { class_type: "VAELoader", inputs: { vae_name: "minimax_h3_video_vae_fp16.safetensors" } },
    "5": {
      class_type: "MiniMaxH3ImageToVideo",
      inputs: {
        clip: ["3", 0],
        vae: ["4", 0],
        prompt: addMotionBias(prompt),
        width: sized.width,
        height: sized.height,
        length: 56,
        ...(source ? { first_frame: ["11", 0] } : {}),
      },
    },
    "6": { class_type: "CLIPTextEncode", inputs: { text: FILM_NEGATIVE, clip: ["3", 0] } },
    "7": {
      class_type: "KSampler",
      inputs: {
        seed,
        steps: 6,
        cfg: 1,
        sampler_name: "euler",
        scheduler: "simple",
        denoise: 1,
        model: ["2", 0],
        positive: ["5", 0],
        negative: ["6", 0],
        latent_image: ["5", 1],
      },
    },
    "8": { class_type: "VAEDecode", inputs: { samples: ["7", 0], vae: ["4", 0] } },
    "9": { class_type: "CreateVideo", inputs: { images: ["8", 0], fps: 12 } },
    "10": { class_type: "SaveVideo", inputs: { video: ["9", 0], filename_prefix: "bot-film", format: "mp4", codec: "h264" } },
    ...(source ? { "11": { class_type: "LoadImage", inputs: { image: source.imageName } } } : {}),
  };
}
