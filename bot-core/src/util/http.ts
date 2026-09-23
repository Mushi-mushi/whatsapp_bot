import { fetchPublicText } from "./public-http.js";

// Small shared HTTP client: one place for timeouts, the SSRF guard, and JSON/text
// parsing so handlers don't each hand-roll fetch + AbortSignal + error handling.

export interface HttpOptions {
  timeoutMs?: number;
  headers?: Record<string, string>;
  method?: string;
  body?: string;
  // Enforce the SSRF guard — REQUIRED for any user-supplied URL.
  safe?: boolean;
  redirect?: "follow" | "error" | "manual";
}

export class HttpError extends Error {
  constructor(public readonly status: number) {
    super(`HTTP ${status}`);
    this.name = "HttpError";
  }
}

async function request(url: string, opts: HttpOptions): Promise<Pick<Response, "ok" | "status" | "json" | "text">> {
  if (opts.safe) {
    if (opts.method && opts.method !== "GET") throw new Error("Public requests must use GET");
    const result = await fetchPublicText(url, opts);
    return { ...result, text: async () => result.body, json: async () => JSON.parse(result.body) };
  }
  return fetch(url, {
    method: opts.method,
    headers: opts.headers,
    body: opts.body,
    redirect: opts.redirect ?? "follow",
    signal: AbortSignal.timeout(opts.timeoutMs ?? 8000),
  });
}

// Throwing JSON GET/POST. Throws HttpError on non-2xx, or on timeout/network error.
export async function getJson<T>(url: string, opts: HttpOptions = {}): Promise<T> {
  const res = await request(url, opts);
  if (!res.ok) throw new HttpError(res.status);
  return (await res.json()) as T;
}

// Best-effort JSON: returns null instead of throwing (for optional public APIs).
export async function tryJson<T>(url: string, opts: HttpOptions = {}): Promise<T | null> {
  try {
    return await getJson<T>(url, opts);
  } catch {
    return null;
  }
}

// Best-effort text: returns null on non-2xx, timeout, or network error.
export async function tryText(url: string, opts: HttpOptions = {}): Promise<string | null> {
  try {
    const res = await request(url, opts);
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  }
}
