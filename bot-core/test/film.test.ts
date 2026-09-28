import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_CONFIG } from "../src/config/schema.js";
import { film } from "../src/handlers/commands/film.js";
import * as comfy from "../src/handlers/commands/paint/comfy.js";
import type { Context } from "../src/router/context.js";

vi.mock("../src/handlers/commands/paint/comfy.js", () => ({
  queuePrompt: vi.fn().mockResolvedValue("job"),
  uploadImage: vi.fn().mockResolvedValue("source.png"),
  waitForVideo: vi.fn().mockResolvedValue({ filename: "result.mp4", subfolder: "", type: "output" }),
  fetchVideo: vi.fn().mockResolvedValue(Buffer.from("video")),
}));

function context(prompt: string, photo: boolean) {
  return {
    config: { ...DEFAULT_CONFIG, paintEnabled: true },
    args: prompt,
    getQuotedImage: vi.fn().mockResolvedValue(photo ? Buffer.from("photo") : null),
    reply: vi.fn(),
    sendVideo: vi.fn(),
  };
}

describe("film command", () => {
  beforeEach(() => vi.clearAllMocks());

  it("uses Wan text-to-video by default for text-only prompts", async () => {
    const ctx = context("a paper airplane flying over a city skyline", false);
    await film(ctx as unknown as Context);
    expect(ctx.reply).not.toHaveBeenCalled();
    expect(ctx.sendVideo).toHaveBeenCalledOnce();
    const workflow = vi.mocked(comfy.queuePrompt).mock.calls[0][1];
    expect(workflow["1"]).toEqual({
      class_type: "UNETLoader",
      inputs: { unet_name: "wan2.1_t2v_1.3b_fp16.safetensors", weight_dtype: "default" },
    });
    expect(workflow["6"]).toMatchObject({
      class_type: "EmptyHunyuanLatentVideo",
      inputs: { width: 832, height: 480, length: 65, batch_size: 1 },
    });
    expect(workflow["11"]).toEqual({
      class_type: "SaveVideo",
      inputs: { video: ["10", 0], filename_prefix: "bot-film", format: "mp4", codec: "h264" },
    });
  });

  it("uses MiniMax when requested", async () => {
    const ctx = context("minimax a paper airplane flying over a city skyline", false);
    await film(ctx as unknown as Context);
    const workflow = vi.mocked(comfy.queuePrompt).mock.calls[0][1];
    expect(workflow["1"]).toEqual({
      class_type: "UNETLoader",
      inputs: { unet_name: "minimax_h3_fl2va_pruned_int8_convrot.safetensors", weight_dtype: "default" },
    });
    expect(workflow["3"]).toEqual({
      class_type: "CLIPLoader",
      inputs: { clip_name: "qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors", type: "minimax", device: "default" },
    });
    expect(workflow["5"]).toMatchObject({ inputs: { width: 768, height: 448, length: 56 } });
  });

  it("uploads quoted image and anchors it for i2v", async () => {
    const ctx = context("wan a robot walking in rain", true);
    await film(ctx as unknown as Context);
    expect(comfy.uploadImage).toHaveBeenCalledOnce();
    const workflow = vi.mocked(comfy.queuePrompt).mock.calls[0][1];
    expect(workflow["15"]).toEqual({ class_type: "LoadImage", inputs: { image: "source.png" } });
    expect(workflow["5"]).toMatchObject({ inputs: { start_image: ["15", 0] } });
  });

  it("uses Wan text-to-video for explicit Wan text-only prompts", async () => {
    const ctx = context("wan a fox running in the snow", false);
    await film(ctx as unknown as Context);
    expect(ctx.reply).not.toHaveBeenCalled();
    expect(comfy.queuePrompt).toHaveBeenCalledOnce();
    const workflow = vi.mocked(comfy.queuePrompt).mock.calls[0][1];
    expect(workflow["1"]).toEqual({
      class_type: "UNETLoader",
      inputs: { unet_name: "wan2.1_t2v_1.3b_fp16.safetensors", weight_dtype: "default" },
    });
    expect(workflow["6"]).toMatchObject({
      class_type: "EmptyHunyuanLatentVideo",
      inputs: { width: 832, height: 480, length: 65, batch_size: 1 },
    });
  });

  it("rejects selector-only prompts", async () => {
    const ctx = context("minimax", false);
    await film(ctx as unknown as Context);
    expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining("Add a video description"));
    expect(comfy.queuePrompt).not.toHaveBeenCalled();
  });
});
