import { performance } from "node:perf_hooks";
import { z } from "zod";
import type { Logger } from "pino";
import type { BotConfig } from "../config/schema.js";
import type { ServiceDiagnostic, ServiceDiagnosticsResponse } from "../../../shared/api.js";

const TIMEOUT_MS = 3000;
const CACHE_MS = 30_000;
const ollamaSchema = z.object({ models: z.array(z.object({ name: z.string() })) });
const comfySchema = z.object({ system: z.object({ comfyui_version: z.string().optional() }) });
const auralisSchema = z.object({ status: z.literal("ok") });

export async function checkService(
  base: string, path: string, schema: z.ZodType<unknown>, logger: Logger, service: ServiceDiagnostic["service"],
): Promise<ServiceDiagnostic> {
  const start = performance.now();
  const signal = AbortSignal.timeout(TIMEOUT_MS);
  const result = (status: ServiceDiagnostic["status"], httpStatus: number | null = null): ServiceDiagnostic => ({
    service, status, checkedAt: Date.now(), latencyMs: Math.round(performance.now() - start), httpStatus,
  });
  let response: Response | undefined;
  let validUrl = false;
  try {
    const url = new URL(`${base.replace(/\/+$/, "")}${path}`);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
      logger.warn({ service }, "Service diagnostics configuration invalid");
      return result("invalid-config");
    }
    validUrl = true;
    response = await fetch(url, { signal, redirect: "error" });
    if (!response.ok) {
      logger.warn({ service, status: response.status }, "Service diagnostics HTTP failure");
      return result("http-error", response.status);
    }
    const payload: unknown = await response.json();
    if (!schema.safeParse(payload).success) {
      logger.warn({ service }, "Service diagnostics response invalid");
      return result("invalid-response", response.status);
    }
    return result("available", response.status);
  } catch (error) {
    const status = !validUrl ? "invalid-config" : signal.aborted ? "timeout"
      : error instanceof SyntaxError ? "invalid-response"
      : error instanceof TypeError && !response ? "unreachable" : "invalid-response";
    logger.warn({ service, status }, "Service diagnostics check failed");
    return result(status, response?.status ?? null);
  } finally {
    if (response?.body && !response.bodyUsed) await response.body.cancel();
  }
}

type DiagnosticsConfig = Pick<BotConfig, "askEnabled" | "ollamaBaseUrl" | "paintEnabled" | "paintBaseUrl"
  | "transcriptionEnabled" | "audioDownloadEnabled" | "transcriptionProvider" | "auralisBaseUrl">;

export class ServiceDiagnostics {
  private cache?: { key: string; expiresAt: number; value: ServiceDiagnosticsResponse };
  private pending = new Map<string, Promise<ServiceDiagnosticsResponse>>();

  constructor(private readonly logger: Logger) {}

  check(config: DiagnosticsConfig): Promise<ServiceDiagnosticsResponse> {
    const relevant: DiagnosticsConfig = {
      askEnabled: config.askEnabled, ollamaBaseUrl: config.ollamaBaseUrl,
      paintEnabled: config.paintEnabled, paintBaseUrl: config.paintBaseUrl,
      transcriptionEnabled: config.transcriptionEnabled, audioDownloadEnabled: config.audioDownloadEnabled,
      transcriptionProvider: config.transcriptionProvider, auralisBaseUrl: config.auralisBaseUrl,
    };
    const key = JSON.stringify(relevant);
    if (this.cache?.key === key && this.cache.expiresAt > Date.now()) return Promise.resolve(structuredClone(this.cache.value));
    const existing = this.pending.get(key);
    if (existing) return existing.then((value) => structuredClone(value));
    const skipped = (service: ServiceDiagnostic["service"], status: "disabled" | "unsupported"): ServiceDiagnostic => ({
      service, status, checkedAt: Date.now(), latencyMs: null, httpStatus: null,
    });
    const request = Promise.all([
      relevant.askEnabled ? checkService(relevant.ollamaBaseUrl, "/api/tags", ollamaSchema, this.logger, "ollama")
        : skipped("ollama", "disabled"),
      relevant.paintEnabled ? checkService(relevant.paintBaseUrl, "/system_stats", comfySchema, this.logger, "comfyui")
        : skipped("comfyui", "disabled"),
      !relevant.transcriptionEnabled || !relevant.audioDownloadEnabled ? skipped("transcription", "disabled")
        : relevant.transcriptionProvider.toLowerCase() !== "auralis" ? skipped("transcription", "unsupported")
        : checkService(relevant.auralisBaseUrl, "/health", auralisSchema, this.logger, "transcription"),
    ]).then((services): ServiceDiagnosticsResponse => {
      const value = { sampledAt: Date.now(), cacheSeconds: 30, services };
      this.cache = { key, expiresAt: Date.now() + CACHE_MS, value };
      return value;
    }).finally(() => { this.pending.delete(key); });
    this.pending.set(key, request);
    return request.then((value) => structuredClone(value));
  }
}
