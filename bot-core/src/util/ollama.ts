import type { BotConfig } from "../config/schema.js";

export interface OllamaMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export type OllamaResult =
  | { ok: true; content: string }
  | { ok: false; reason: "notfound" | "timeout" | "unreachable" | "error"; status?: number };

// Single place that talks to the local Ollama /api/chat endpoint (non-streaming).
// numPredict caps output tokens; timeoutMs overrides the config timeout for heavy
// jobs (e.g. summarizing a long page).
export async function ollamaChat(
  cfg: BotConfig,
  messages: OllamaMessage[],
  opts: { numPredict?: number; timeoutMs?: number } = {},
): Promise<OllamaResult> {
  const numPredict = opts.numPredict ?? 512;
  const timeoutMs = opts.timeoutMs ?? cfg.ollamaTimeoutSeconds * 1000;
  const base = cfg.ollamaBaseUrl.replace(/\/+$/, "");
  try {
    const res = await fetch(`${base}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: cfg.ollamaModel,
        stream: false,
        // Disable the reasoning phase on "thinking" models (e.g. GLM) so they
        // answer directly instead of burning the token budget on hidden thoughts.
        think: false,
        messages,
        // num_ctx large enough to fit long inputs (e.g. bot.tldr) without truncation.
        options: { num_predict: numPredict, num_ctx: 8192 },
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) {
      return { ok: false, reason: res.status === 404 ? "notfound" : "error", status: res.status };
    }
    const data = (await res.json()) as { message?: { content?: string } };
    const content = data.message?.content?.trim();
    return content ? { ok: true, content } : { ok: false, reason: "error" };
  } catch (err) {
    const timedOut = err instanceof Error && err.name === "TimeoutError";
    return { ok: false, reason: timedOut ? "timeout" : "unreachable" };
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
