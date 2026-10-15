import type { BotConfig } from "../config/schema.js";

export interface OllamaMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export type OllamaResult =
  | { ok: true; content: string }
  | { ok: false; reason: "notfound" | "timeout" | "unreachable" | "error"; status?: number };

// Single place that talks to the local Ollama /api/chat endpoint (non-streaming).
// numPredict caps output tokens; timeoutMs is treated as an INACTIVITY timeout —
// the request is aborted only if Ollama produces no new output for that long, so a
// slow-but-progressing answer (contended GPU, long generation) isn't killed early.
export async function ollamaChat(
  cfg: BotConfig,
  messages: OllamaMessage[],
  opts: { numPredict?: number; numCtx?: number; timeoutMs?: number; model?: string } = {},
): Promise<OllamaResult> {
  const model = opts.model?.trim() || cfg.ollamaModel;
  const numPredict = opts.numPredict ?? 512;
  // Keep the default context small so short commands (e.g. bot.ask) stay light;
  // callers with long inputs (e.g. bot.tldr) opt into a bigger window.
  const numCtx = opts.numCtx ?? 4096;
  const timeoutMs = opts.timeoutMs ?? cfg.ollamaTimeoutSeconds * 1000;
  const base = cfg.ollamaBaseUrl.replace(/\/+$/, "");
  const controller = new AbortController();
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  const resetIdle = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
  };
  try {
    resetIdle();
    const res = await fetch(`${base}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        stream: true,
        // Configurable model-retention window (default = Ollama's own 5m).
        keep_alive: cfg.ollamaKeepAlive,
        // Disable the reasoning phase on "thinking" models (e.g. GLM) so they
        // answer directly instead of burning the token budget on hidden thoughts.
        think: false,
        messages,
        options: { num_predict: numPredict, num_ctx: numCtx },
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      return { ok: false, reason: res.status === 404 ? "notfound" : "error", status: res.status };
    }
    if (!res.body) return { ok: false, reason: "error" };

    // Ollama streams newline-delimited JSON; accumulate message.content chunks and
    // reset the inactivity timer on each one so a slow stream stays alive.
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let content = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      resetIdle();
      buffer += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line) continue;
        const chunk = JSON.parse(line) as { message?: { content?: string }; done?: boolean };
        content += chunk.message?.content ?? "";
      }
    }

    const trimmed = content.trim();
    return trimmed ? { ok: true, content: trimmed } : { ok: false, reason: "error" };
  } catch {
    // A timeout aborts via controller; anything else means the stream dropped.
    return { ok: false, reason: timedOut ? "timeout" : "unreachable" };
  } finally {
    if (idleTimer) clearTimeout(idleTimer);
  }
}

export function ollamaErrorMessage(
  r: Extract<OllamaResult, { ok: false }>,
  model: string,
): string {
  switch (r.reason) {
    case "notfound":
      return `Model "${model}" isn't available on Ollama. Check the model name in Settings.`;
    case "timeout":
      return "That took too long. Try a shorter input or a faster model.";
    case "unreachable":
      return "I couldn't reach Ollama. Make sure it's running on the host.";
    default:
      return `Ollama returned an error${r.status ? ` (${r.status})` : ""}.`;
  }
}

export type OllamaModelsResult =
  | { ok: true; models: string[] }
  | { ok: false; reason: "unreachable" };

// List the models installed on the configured Ollama instance (GET /api/tags).
export async function ollamaListModels(cfg: BotConfig): Promise<OllamaModelsResult> {
  const base = cfg.ollamaBaseUrl.replace(/\/+$/, "");
  try {
    const res = await fetch(`${base}/api/tags`, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return { ok: false, reason: "unreachable" };
    const data = (await res.json()) as { models?: { name?: string }[] };
    const models = (data.models ?? []).map((m) => m.name).filter((n): n is string => !!n);
    return { ok: true, models };
  } catch {
    return { ok: false, reason: "unreachable" };
  }
}
