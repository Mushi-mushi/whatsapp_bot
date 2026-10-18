import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, ApiError, clearToken, setToken } from "./api";
import type {
  ConfigSaveResponse, ConfigSnapshot, PetSettings, PetUpdate,
  PetActionResponse, ProfileDetail, ProfileRefreshResponse, DisciplineMutationResponse,
} from "../../../shared/api.js";

import { config, operations } from "@/test/fixtures";
const settings: PetSettings = {
  wakeStart: 8, wakeEnd: 22, firstRequestMinutes: 15,
  requestMinHours: 8, requestMaxHours: 12, maxRequestsPerDay: 3,
  activityWindowHours: 6, responseMinutes: 30, silenceMinutes: 2,
};
const profile: ProfileDetail = {
  sender_key: '["group@g.us","123"]', name: "Alice", short: "A summary", updated_at: 100,
  chat_id: "group@g.us", chat_name: "Friends",
  messageCount: 5, last_profiled_id: 12, deep: "A dossier",
};
const petAction: PetActionResponse = {
  revision: '"pet-settings"',
  pet: {
    name: "Mochi", species: "bird", enabled: true, paused: false, settings,
    stage: 0, hunger: 100, hydration: 100, cleanliness: 100, happiness: 100, energy: 100,
    hibernating: false, healthyDays: 0, status: "Healthy",
    evolution: { nextForm: "Cloud Chick", remainingHealthyMs: 86400000, sampledAt: 100, running: true, frozenReason: null, canForce: true },
    nextRequestActiveMinutes: 15, request: null,
  },
};
const fetcher = vi.fn<typeof fetch>();

beforeEach(() => {
  fetcher.mockReset();
  vi.stubGlobal("fetch", fetcher);
  setToken("contract-test");
});
afterEach(() => {
  clearToken();
  vi.unstubAllGlobals();
});

describe("shared API wire contracts", () => {
  it("fetches the operations contract without caching and includes authentication", async () => {
    fetcher.mockResolvedValue(Response.json(operations));
    expect(await api.getOperations()).toEqual(operations);
    expect(fetcher.mock.calls[0][0]).toBe("/api/operations");
    expect(fetcher.mock.calls[0][1]?.cache).toBe("no-store");
    expect(new Headers(fetcher.mock.calls[0][1]?.headers).has("Authorization")).toBe(true);
  });
  it("reads raw configuration and captures the revision from ETag", async () => {
    fetcher.mockResolvedValue(Response.json(config, { headers: { ETag: '"first"' } }));
    const result: ConfigSnapshot = await api.getConfig();
    expect(result).toEqual({ config, revision: '"first"' });
    expect(fetcher.mock.calls[0][0]).toBe("/api/config");
    expect(new Headers(fetcher.mock.calls[0][1]?.headers).get("Authorization")).toBe("Bearer contract-test");
  });

  it("writes raw configuration with If-Match and reads the save envelope", async () => {
    const response: ConfigSaveResponse = { ok: true, config: { ...config, botReplyPrefix: "Saved:" } };
    fetcher.mockResolvedValue(Response.json(response, { headers: { ETag: '"second"' } }));
    expect(await api.saveConfig({ config, revision: '"first"' })).toEqual({
      config: response.config, revision: '"second"',
    });
    const init = fetcher.mock.calls[0][1]!;
    expect(init.method).toBe("PUT");
    expect(new Headers(init.headers).get("If-Match")).toBe('"first"');
    expect(JSON.parse(init.body as string)).toEqual(config);
  });

  it("rejects stale configuration writes rather than returning a success contract", async () => {
    fetcher.mockResolvedValue(Response.json({ ok: false, error: "Configuration changed elsewhere." }, { status: 412 }));
    await expect(api.saveConfig({ config, revision: '"old"' })).rejects.toMatchObject({
      status: 412, message: "Configuration changed elsewhere.",
    });
  });

  it("preserves profile list/detail/refresh payloads including the stored watermark", async () => {
    const { deep: _deep, last_profiled_id: _id, ...summary } = profile;
    fetcher.mockResolvedValueOnce(Response.json({ profiles: [summary] }))
      .mockResolvedValueOnce(Response.json(profile))
      .mockResolvedValueOnce(Response.json({ ok: true, profile } satisfies ProfileRefreshResponse));
    expect(await api.getProfiles()).toEqual({ profiles: [summary] });
    expect(await api.getProfile(profile.sender_key)).toEqual(profile);
    expect(await api.refreshProfile(profile.sender_key)).toEqual({ ok: true, profile });
    const path = `/api/profiles/${encodeURIComponent(profile.sender_key)}`;
    expect(fetcher.mock.calls.map(([url]) => url)).toEqual(["/api/profiles", path, `${path}/refresh`]);
  });

  it("preserves the pet action envelope and settings revision", async () => {
    const update: PetUpdate = { action: "save", name: "Mochi", species: "bird", settings };
    fetcher.mockResolvedValue(Response.json(petAction));
    expect(await api.updatePet("group@g.us", '"pet-settings"', update)).toEqual(petAction);
    expect(new Headers(fetcher.mock.calls[0][1]?.headers).get("If-Match")).toBe('"pet-settings"');
    expect(JSON.parse(fetcher.mock.calls[0][1]!.body as string)).toEqual(update);
  });

  it("encodes pet identifiers and serializes request and evolution payloads", async () => {
    fetcher.mockImplementation(async () => Response.json(petAction));
    const id = "group/with space@g.us";
    expect(await api.requestPet(id)).toEqual(petAction);
    expect(await api.requestPet(id, "feed")).toEqual(petAction);
    expect(await api.evolvePet(id, 2)).toEqual(petAction);
    expect(fetcher.mock.calls.map(([url]) => url)).toEqual([
      "/api/pets/group%2Fwith%20space%40g.us/request",
      "/api/pets/group%2Fwith%20space%40g.us/request",
      "/api/pets/group%2Fwith%20space%40g.us/evolve",
    ]);
    expect(fetcher.mock.calls.map(([, init]) => {
      expect(init?.method).toBe("POST");
      expect(new Headers(init?.headers).get("Content-Type")).toBe("application/json");
      return JSON.parse(init!.body as string);
    })).toEqual([{ kind: "random" }, { kind: "feed" }, { expectedStage: 2 }]);
  });

  it("reads discipline mutation envelopes without changing identifiers", async () => {
    const result: DisciplineMutationResponse = {
      ok: true,
      players: [{ chatId: "group@g.us", chatName: "Group", senderId: "123@s.whatsapp.net", displayName: "Alice", sleepUntil: null, armed: true }],
    };
    fetcher.mockResolvedValue(Response.json(result));
    expect(await api.armPlayer("group@g.us", "123@s.whatsapp.net")).toEqual(result);
    expect(JSON.parse(fetcher.mock.calls[0][1]!.body as string)).toEqual({
      chatId: "group@g.us", senderId: "123@s.whatsapp.net",
    });
  });

  it("keeps API failures out of typed success responses", async () => {
    fetcher.mockResolvedValue(Response.json({ ok: false, error: "Profile refresh queue is busy." }, { status: 503 }));
    await expect(api.refreshProfile("123")).rejects.toBeInstanceOf(ApiError);
  });

  it.each([401, 502])("surfaces ComfyUI HTTP %s instead of returning a successful offline status", async (status) => {
    fetcher.mockResolvedValue(Response.json({ error: "service unavailable" }, { status }));
    await expect(api.getComfyStatus()).rejects.toMatchObject({ status, message: "service unavailable" });
  });

  it("propagates ComfyUI network failures and invalid JSON", async () => {
    fetcher.mockRejectedValueOnce(new TypeError("network failed"));
    await expect(api.getComfyStatus()).rejects.toThrow("network failed");
    fetcher.mockResolvedValueOnce(new Response("invalid json"));
    await expect(api.getComfyStatus()).rejects.toBeInstanceOf(SyntaxError);
  });

  it("preserves a successful ComfyUI status", async () => {
    fetcher.mockResolvedValue(Response.json({ ok: true, reachable: true, version: "1.2" }));
    expect(await api.getComfyStatus()).toEqual({ ok: true, reachable: true, version: "1.2" });
  });
});
