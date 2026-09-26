import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_CONFIG } from "../src/config/schema.js";
import { paint, paintImage } from "../src/handlers/commands/paint.js";
import * as comfy from "../src/handlers/commands/paint/comfy.js";
import { buildAmanesseWorkflow } from "../src/handlers/commands/paint/workflows.js";
import type { Context } from "../src/router/context.js";

vi.mock("../src/handlers/commands/paint/comfy.js", () => ({
  queuePrompt: vi.fn().mockResolvedValue("job"),
  uploadImage: vi.fn().mockResolvedValue("source.png"),
  waitForImage: vi.fn().mockResolvedValue({ filename: "result.png", subfolder: "", type: "output" }),
  fetchImage: vi.fn().mockResolvedValue(Buffer.from("result")),
}));

function context(prompt: string, photo: boolean) {
  return {
    config: { ...DEFAULT_CONFIG, paintEnabled: true },
    args: prompt,
    text: `bot.paint ${prompt}`,
    getQuotedImage: vi.fn().mockResolvedValue(photo ? Buffer.from("photo") : null),
    downloadImage: vi.fn().mockResolvedValue(Buffer.from("photo")),
    reply: vi.fn(),
    sendImage: vi.fn(),
  };
}

describe("paint model routing", () => {
  beforeEach(() => vi.clearAllMocks());

  it.each(["amanesse", "model=amanesse"])("uses the full %s preset for text and both photo paths", async (selector) => {
    for (const mode of ["text", "reply", "caption"]) {
      vi.clearAllMocks();
      const ctx = context(`${selector} a mountain village${mode === "text" ? "" : " d=0.65"}`, mode === "reply");
      await (mode === "caption" ? paintImage : paint)(ctx as unknown as Context);
      expect(ctx.reply).not.toHaveBeenCalled();
      expect(ctx.sendImage).toHaveBeenCalledOnce();
      const workflow = vi.mocked(comfy.queuePrompt).mock.calls[0][1];
      expect(workflow["4"]).toEqual({ class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: "amanesseWorks_v20.safetensors" } });
      const loras = [
        ["96YOTTEA-WAI.safetensors", 0.5],
        ["Rapscallion_Illustrious.safetensors", 0.1],
        ["ppw_v8_Illuv2stable_128.safetensors", 0.4],
        ["venus_body_ILXL_v2.safetensors", 2.5],
        ["niji_and_midj_mix217.safetensors", 0.4],
      ] as const;
      loras.forEach(([name, strength], index) => {
        const previous = index === 0 ? "4" : String(19 + index);
        expect(workflow[String(20 + index)]).toEqual({ class_type: "LoraLoader", inputs: {
          model: [previous, 0], clip: [previous, 1], lora_name: name, strength_model: strength, strength_clip: strength,
        } });
      });
      expect(workflow["25"]).toEqual({ class_type: "CLIPSetLastLayer", inputs: { clip: ["24", 1], stop_at_clip_layer: -2 } });
      expect(workflow["6"]).toEqual({ class_type: "CLIPTextEncode", inputs: { clip: ["25", 0], text: expect.stringMatching(/^Rapscallionstyle, .*a mountain village/) } });
      expect(workflow["7"]).toMatchObject({ inputs: { clip: ["25", 0], text: expect.stringContaining("lowres, worst quality") } });
      expect(workflow["3"]).toEqual({ class_type: "KSampler", inputs: {
        seed: expect.any(Number), steps: 30, cfg: 7, sampler_name: "dpmpp_2m", scheduler: "karras",
        denoise: mode === "text" ? 1 : 0.65, model: ["24", 0], positive: ["6", 0], negative: ["7", 0],
        latent_image: [mode === "text" ? "5" : "11", 0],
      } });
      if (mode === "text") {
        expect(workflow["5"]).toEqual({ class_type: "EmptyLatentImage", inputs: { width: 832, height: 1216, batch_size: 1 } });
      } else {
        expect(workflow["10"]).toEqual({ class_type: "LoadImage", inputs: { image: "source.png" } });
        expect(workflow["11"]).toEqual({ class_type: "VAEEncode", inputs: { pixels: ["10", 0], vae: ["4", 2] } });
      }
    }
  });

  it("does not mutate global settings or duplicate the preset trigger", () => {
    const cfg = { ...DEFAULT_CONFIG };
    const workflow = buildAmanesseWorkflow(cfg, "Rapscallionstyle, a village", 42);
    expect(cfg).toEqual(DEFAULT_CONFIG);
    expect(workflow["6"]).toMatchObject({ inputs: { text: "Rapscallionstyle, a village" } });
    expect(workflow["3"]).toMatchObject({ inputs: { seed: 42 } });
  });

  it.each([
    ["sdxl", DEFAULT_CONFIG.paintCheckpoint],
    ["hunyuan", "hunyuan_dit_1.2.safetensors"],
    ["pony", "ponyDiffusionV6XL_v6StartWithThisOne.safetensors"],
    ["model=pony", "ponyDiffusionV6XL_v6StartWithThisOne.safetensors"],
    ["model=DreamShaper_8_pruned.safetensors", "DreamShaper_8_pruned.safetensors"],
    ["ckpt=juggernautXL_v9Rdphoto2Lightning.safetensors", "juggernautXL_v9Rdphoto2Lightning.safetensors"],
    ["model=ponyDiffusionV6XL_v6StartWithThisOne.safetensors", "ponyDiffusionV6XL_v6StartWithThisOne.safetensors"],
  ])("honors %s in text, quoted-photo and captioned-photo requests", async (selector, checkpoint) => {
    for (const mode of ["text", "reply", "caption"]) {
      vi.clearAllMocks();
      const ctx = context(`${selector} a red sailing boat`, mode === "reply");
      await (mode === "caption" ? paintImage : paint)(ctx as unknown as Context);
      expect(ctx.reply).not.toHaveBeenCalled();
      expect(ctx.sendImage).toHaveBeenCalledOnce();
      expect(comfy.queuePrompt).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({
        "4": { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: checkpoint } },
        ...(mode === "text" ? {} : {
          "10": { class_type: "LoadImage", inputs: { image: "source.png" } },
          "11": { class_type: "VAEEncode", inputs: { pixels: ["10", 0], vae: ["4", 2] } },
        }),
      }), expect.any(String));
    }
  });

  it("keeps Kontext for photo edits without a model selector", async () => {
    const ctx = context("a red sailing boat", true);
    await paint(ctx as unknown as Context);
    expect(comfy.queuePrompt).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({
      "3": expect.objectContaining({ class_type: "UNETLoader" }),
    }), expect.any(String));
  });

  it.each(["flux", "flux hard", `model=${DEFAULT_CONFIG.paintFluxCheckpoint}`])("uses Flux for %s photo edits", async (selector) => {
    const ctx = context(`${selector} red sails d=0.8 g=4`, true);
    await paint(ctx as unknown as Context);
    expect(comfy.queuePrompt).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({
      "4": { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: DEFAULT_CONFIG.paintFluxCheckpoint } },
      "5": { class_type: "VAEEncode", inputs: { pixels: ["11", 0], vae: ["4", 2] } },
      "3": expect.objectContaining({ inputs: expect.objectContaining({ denoise: 0.8, cfg: 1, latent_image: ["5", 0] }) }),
      "10": { class_type: "FluxGuidance", inputs: { conditioning: ["6", 0], guidance: 4 } },
    }), expect.any(String));
  });

  it.each(["wan", "model=wan2.5"])("never queues cloud requests for %s", async (selector) => {
    for (const mode of ["text", "reply", "caption"]) {
      const ctx = context(`${selector} red sails`, mode === "reply");
      await (mode === "caption" ? paintImage : paint)(ctx as unknown as Context);
      expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining("Wan is not available"));
      expect(comfy.uploadImage).not.toHaveBeenCalled();
      expect(comfy.queuePrompt).not.toHaveBeenCalled();
    }
  });

  it("does not generate a new image when downloading the quoted photo fails", async () => {
    const ctx = context("sdxl red sails", true);
    ctx.getQuotedImage.mockRejectedValue(new Error("download failed"));
    await paint(ctx as unknown as Context);
    expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining("Couldn't download"));
    expect(comfy.queuePrompt).not.toHaveBeenCalled();
  });

  it.each([false, true])("rejects model-only requests (photo=%s)", async (photo) => {
    const ctx = context("hunyuan", photo);
    await paint(ctx as unknown as Context);
    expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining("Add an image description"));
    expect(comfy.queuePrompt).not.toHaveBeenCalled();
  });
});