import { describe, expect, it } from "vitest";
import { extractCommandToken, normalizeName } from "../src/router/normalize.js";

describe("normalizeName", () => {
  it("strips accents, emoji variation selectors, and casing", () => {
    expect(normalizeName("Hernán")).toBe("hernan");
    expect(normalizeName("Famille ❤️")).toBe("famille ❤");
    expect(normalizeName("  Work   Phone  NESTLE ")).toBe("work phone nestle");
  });
});

describe("extractCommandToken", () => {
  it("extracts a plain command", () => {
    expect(extractCommandToken("bot.jokes")).toBe("bot.jokes");
  });

  it("extracts from a group-prefixed message with trailing time", () => {
    expect(extractCommandToken("Work Phone NESTLE bot.roast Si Ying 15:01")).toBe(
      "bot.roast Si Ying",
    );
  });

  it("supports dotted subcommands", () => {
    expect(extractCommandToken("bot.roast.neg Baptiste")).toBe("bot.roast.neg Baptiste");
  });

  it("returns null when no command present", () => {
    expect(extractCommandToken("just a normal message")).toBeNull();
  });
});
