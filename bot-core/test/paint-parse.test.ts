import { describe, it, expect } from "vitest";
import {
  parseGuidance,
  parseModel,
  parsePixelate,
  parseRestyle,
} from "../src/handlers/commands/paint/parse.js";

describe("parseGuidance", () => {
  it("returns the fallback when no flag is present", () => {
    expect(parseGuidance("a cat", 3.5)).toEqual({ guidance: 3.5, text: "a cat" });
  });

  it("extracts and strips a g= flag", () => {
    expect(parseGuidance("a cat g=4", 3.5)).toEqual({ guidance: 4, text: "a cat" });
  });

  it("accepts guidance= and clamps to 1-10", () => {
    expect(parseGuidance("x guidance=99", 3.5).guidance).toBe(10);
    expect(parseGuidance("x g=0", 3.5).guidance).toBe(1);
  });
});

describe("parsePixelate", () => {
  it("detects pixelate variants with a default factor", () => {
    expect(parsePixelate("make it pixelated")).toEqual({ pixelate: true, factor: 24 });
    expect(parsePixelate("8-bit please").pixelate).toBe(true);
  });

  it("reads and clamps a p= block factor", () => {
    expect(parsePixelate("pixelate p=40").factor).toBe(40);
    expect(parsePixelate("pixelate p=200").factor).toBe(64);
    expect(parsePixelate("pixelate p=1").factor).toBe(6);
  });

  it("is false for normal prompts", () => {
    expect(parsePixelate("a red car").pixelate).toBe(false);
  });
});

describe("parseRestyle", () => {
  it("detects hard/strong and strips the token", () => {
    expect(parseRestyle("hard monet painting")).toEqual({
      hard: true,
      denoise: null,
      text: "monet painting",
    });
  });

  it("reads and clamps a d= denoise override", () => {
    const r = parseRestyle("strong picasso d=0.8");
    expect(r.hard).toBe(true);
    expect(r.denoise).toBe(0.8);
    expect(r.text).toBe("picasso");
  });

  it("leaves plain prompts untouched", () => {
    expect(parseRestyle("a watercolor cat")).toEqual({
      hard: false,
      denoise: null,
      text: "a watercolor cat",
    });
  });
});

describe("parseModel", () => {
  it.each(["retroanime", "RETROANIME", "model=retroanime", "ckpt=retroanime"])("resolves %s as a preset", (selector) => {
    expect(parseModel(`${selector} a village`)).toEqual({
      model: "retroanime", text: "a village", selected: true, checkpoint: null,
    });
  });

  it.each(["amanesse", "AMANESSE", "model=amanesse", "ckpt=amanesse"])("resolves %s as a preset", (selector) => {
    expect(parseModel(`${selector} a village`)).toEqual({
      model: "amanesse", text: "a village", selected: true, checkpoint: null,
    });
  });

  it.each(["pony", "PONY", "model=pony", "ckpt=pony"])("resolves %s to the installed Pony checkpoint", (selector) => {
    expect(parseModel(`${selector} a castle`)).toEqual({
      model: "sdxl", text: "a castle", selected: true,
      checkpoint: "ponyDiffusionV6XL_v6StartWithThisOne.safetensors",
    });
  });

  it("leaves pony subjects in ordinary prompts untouched", () => {
    expect(parseModel("a pony in a field")).toEqual({
      model: "sdxl", text: "a pony in a field", checkpoint: null, selected: false,
    });
  });

  it("defaults to sdxl", () => {
    expect(parseModel("a castle")).toEqual({ model: "sdxl", text: "a castle", checkpoint: null, selected: false });
  });

  it("selects flux and strips the keyword", () => {
    expect(parseModel("flux a castle")).toEqual({ model: "flux", text: "a castle", checkpoint: null, selected: true });
    expect(parseModel("flux1 a castle").model).toBe("flux");
  });

  it("strips an explicit sdxl keyword", () => {
    expect(parseModel("sdxl a castle")).toEqual({ model: "sdxl", text: "a castle", checkpoint: null, selected: true });
  });

  it("accepts explicit checkpoint overrides", () => {
    expect(parseModel("model=JuggernautXL_v9.safetensors a castle")).toEqual({
      model: "sdxl",
      text: "a castle",
      checkpoint: "JuggernautXL_v9.safetensors",
      selected: true,
    });
    expect(parseModel("ckpt=myModel.safetensors dreamy photo").checkpoint).toBe("myModel.safetensors");
  });

  it("supports model=flux as an explicit selector", () => {
    expect(parseModel("model=flux a castle")).toEqual({
      model: "flux",
      text: "a castle",
      checkpoint: null,
      selected: true,
    });
  });

  it("supports hunyuan selector", () => {
    expect(parseModel("hunyuan a castle")).toEqual({
      model: "sdxl",
      text: "a castle",
      checkpoint: "hunyuan_dit_1.2.safetensors",
      selected: true,
    });
    expect(parseModel("model=hunyuan a castle").checkpoint).toBe("hunyuan_dit_1.2.safetensors");
  });

  it("supports wan selector", () => {
    expect(parseModel("wan a castle")).toEqual({ model: "wan", text: "a castle", checkpoint: null, selected: true });
    expect(parseModel("model=wan2.5 a castle").model).toBe("wan");
  });

  it("preserves quoted checkpoint filenames with spaces", () => {
    expect(parseModel('model="folder/My Model.safetensors" a castle')).toMatchObject({
      checkpoint: "folder/My Model.safetensors", text: "a castle", selected: true,
    });
  });
});
