import { describe, it, expect } from "vitest";
import { openDatabase } from "../src/state/db.js";
import { TriviaScoreStore } from "../src/state/repos.js";

const jan = new Date(2026, 0, 15).getTime();
const feb = new Date(2026, 1, 2).getTime();
const mar = new Date(2026, 2, 2).getTime();

describe("TriviaScoreStore monthly rollover", () => {
  it("awards a trophy to the month's top scorer and resets scores", () => {
    const store = new TriviaScoreStore(openDatabase(":memory:"));
    store.add("c", "ann", "Ann", 3, jan);
    store.add("c", "bob", "Bob", 1, jan);

    expect(store.top("c", 5, feb)).toEqual([]);
    expect(store.trophies("c")).toEqual([{ name: "Ann", trophies: 1 }]);
    expect(store.history("c")).toEqual([{ period: "2026-01", name: "Ann", score: 3 }]);
  });

  it("shares the trophy on ties and skips non-positive winners", () => {
    const store = new TriviaScoreStore(openDatabase(":memory:"));
    store.add("c", "ann", "Ann", 2, jan);
    store.add("c", "bob", "Bob", 2, jan);
    store.add("d", "cy", "Cy", -1, jan);
    store.top("c", 5, feb);

    expect(store.trophies("c").map((t) => t.name).sort()).toEqual(["Ann", "Bob"]);
    expect(store.trophies("d")).toEqual([]);
  });

  it("accumulates trophies across months", () => {
    const store = new TriviaScoreStore(openDatabase(":memory:"));
    store.add("c", "ann", "Ann", 1, jan);
    store.add("c", "ann", "Ann", 1, feb);
    store.top("c", 5, mar);

    expect(store.trophies("c")).toEqual([{ name: "Ann", trophies: 2 }]);
  });
});
