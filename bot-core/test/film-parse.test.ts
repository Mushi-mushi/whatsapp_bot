import { describe, expect, it } from "vitest";
import { parseFilmModel } from "../src/handlers/commands/film/parse.js";

describe("parseFilmModel", () => {
  it.each([
    ["a drone flies over snowy mountains", { model: "wan", text: "a drone flies over snowy mountains", selected: false }],
    ["wan a drone flies over snowy mountains", { model: "wan", text: "a drone flies over snowy mountains", selected: true }],
    ["minimax a drone flies over snowy mountains", { model: "minimax", text: "a drone flies over snowy mountains", selected: true }],
    ["model=minimax a drone flies over snowy mountains", { model: "minimax", text: "a drone flies over snowy mountains", selected: true }],
    ["engine=wan a drone flies over snowy mountains", { model: "wan", text: "a drone flies over snowy mountains", selected: true }],
  ] as const)("parses %s", (input, expected) => {
    expect(parseFilmModel(input)).toEqual(expected);
  });
});
