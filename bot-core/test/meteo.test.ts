import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_CONFIG } from "../src/config/schema.js";
import { meteo } from "../src/handlers/commands/meteo.js";
import * as http from "../src/util/http.js";
import type { Context } from "../src/router/context.js";

vi.mock("../src/util/http.js", () => ({ tryJson: vi.fn() }));

function context(args: string) {
  return { config: DEFAULT_CONFIG, args, reply: vi.fn() };
}

const sample = {
  nearest_area: [{ areaName: [{ value: "Barcelona" }] }],
  weather: [
    { date: "2026-10-08", maxtempC: "24", mintempC: "18", hourly: [{ time: "1200", weatherDesc: [{ value: "Partly cloudy" }] }] },
    { date: "2026-10-09", maxtempC: "25", mintempC: "17", hourly: [{ time: "1200", weatherDesc: [{ value: "Sunny" }] }] },
    { date: "2026-10-10", maxtempC: "21", mintempC: "15", hourly: [{ time: "1200", weatherDesc: [{ value: "Light rain" }] }] },
    { date: "2026-10-11", maxtempC: "20", mintempC: "14", hourly: [{ time: "1200", weatherDesc: [{ value: "Overcast" }] }] },
  ],
};

describe("meteo command", () => {
  beforeEach(() => vi.clearAllMocks());

  it("defaults to Barcelona and reports three days", async () => {
    vi.mocked(http.tryJson).mockResolvedValue(sample);
    const ctx = context("");
    await meteo(ctx as unknown as Context);

    expect(vi.mocked(http.tryJson).mock.calls[0][0]).toContain("Barcelona");
    const message = ctx.reply.mock.calls[0][0] as string;
    expect(message).toContain("3-day forecast for Barcelona");
    expect(message).toContain("Partly cloudy, 18–24°C");
    expect(message).toContain("Sunny, 17–25°C");
    expect(message).toContain("Light rain, 15–21°C");
    // Only three days, not four.
    expect(message).not.toContain("Overcast");
  });

  it("uses a supplied location override", async () => {
    vi.mocked(http.tryJson).mockResolvedValue(sample);
    const ctx = context("Madrid");
    await meteo(ctx as unknown as Context);
    expect(vi.mocked(http.tryJson).mock.calls[0][0]).toContain("Madrid");
  });

  it("reports an error when the service is unreachable", async () => {
    vi.mocked(http.tryJson).mockResolvedValue(null);
    const ctx = context("");
    await meteo(ctx as unknown as Context);
    expect(ctx.reply.mock.calls[0][0]).toContain("couldn't reach the weather service");
  });
});
