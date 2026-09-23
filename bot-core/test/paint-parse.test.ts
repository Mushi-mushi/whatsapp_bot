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
  it("defaults to sdxl", () => {
    expect(parseModel("a castle")).toEqual({ model: "sdxl", text: "a castle" });
  });

  it("selects flux and strips the keyword", () => {
    expect(parseModel("flux a castle")).toEqual({ model: "flux", text: "a castle" });
    expect(parseModel("flux1 a castle").model).toBe("flux");
  });

  it("strips an explicit sdxl keyword", () => {
    expect(parseModel("sdxl a castle")).toEqual({ model: "sdxl", text: "a castle" });
  });
});
